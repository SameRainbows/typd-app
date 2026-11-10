set -eu
python3 -m venv /tmp/typd-gpu-venv
/tmp/typd-gpu-venv/bin/python -m pip install --disable-pip-version-check torch==2.14.0 numpy
cat > /tmp/typd-gpu-check.py <<'PYTHON'
"""Small GPU acceptance check. No network, purchases, or CPU fallback.

Run with an existing PyTorch installation: python gpu-acceptance-probe.py
Exit 0: GPU checks pass and reported capacity >= 24 decimal GB.
Exit 2: checks pass but reported capacity does not meet that minimum.
Exit 1: missing GPU/dependency or a failed check.
Reported capacity is metadata, not proof of a full-size allocation or quota.
"""
import json
from pathlib import Path
import platform
import sys
import tempfile
import time


def run():
    import torch

    report = {"torch": torch.__version__, "platform": platform.system()}
    if torch.cuda.is_available():
        device, backend = "cuda", torch.cuda
        report["backend"] = "rocm" if torch.version.hip else "cuda"
    elif hasattr(torch, "xpu") and torch.xpu.is_available():
        device, backend = "xpu", torch.xpu
        report["backend"] = "xpu"
    elif torch.backends.mps.is_available():
        device, backend = "mps", torch.mps
        report["backend"] = "mps"
    else:
        raise RuntimeError("No PyTorch-accessible GPU. CPU is not accepted.")

    if device == "mps":
        capacity = backend.recommended_max_memory()
        report.update(device="Apple Metal device", memory_kind="recommended GPU working-set size")
    else:
        capacity = backend.get_device_properties(0).total_memory
        report.update(device=backend.get_device_name(0), memory_kind="device total memory")
    report.update(reported_memory_bytes=capacity,
                  reported_memory_GB=capacity / 1e9,
                  reported_memory_GiB=capacity / 1024**3,
                  reported_capacity_meets_24_GB=capacity >= 24_000_000_000)

    torch.manual_seed(19)
    model = torch.nn.Linear(1024, 1024).to(device)
    x = torch.randn(32, 1024).to(device)
    optimizer = torch.optim.SGD(model.parameters(), lr=0.01)
    started = time.monotonic()
    for _ in range(5):
        optimizer.zero_grad(set_to_none=True)
        loss = model(x).square().mean()
        loss.backward()
        if not torch.isfinite(loss).item():
            raise RuntimeError("Nonfinite loss")
        for parameter in model.parameters():
            if parameter.grad is None or not torch.isfinite(parameter.grad).all().item():
                raise RuntimeError("Missing or nonfinite GPU gradient")
        optimizer.step()
    backend.synchronize()
    report.update(training_steps=5, training_seconds=time.monotonic() - started,
                  backward_pass="passed", final_loss=loss.item())

    state = {key: value.detach().cpu() for key, value in model.state_dict().items()}
    with tempfile.TemporaryDirectory(prefix="gpu-acceptance-") as directory:
        checkpoint = Path(directory) / "checkpoint.pt"
        torch.save(state, checkpoint)
        restored = torch.load(checkpoint, map_location="cpu", weights_only=True)
        if state.keys() != restored.keys() or any(
            not torch.equal(value, restored[key]) for key, value in state.items()
        ):
            raise RuntimeError("Checkpoint round trip failed")
        report.update(checkpoint_round_trip="passed", checkpoint_bytes=checkpoint.stat().st_size)

    print(json.dumps(report, indent=2))
    return 0 if report["reported_capacity_meets_24_GB"] else 2


if __name__ == "__main__":
    try:
        sys.exit(run())
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}))
        sys.exit(1)

PYTHON
/tmp/typd-gpu-venv/bin/python -c "import sys; sys.path.insert(0, '/tmp'); import importlib.util; spec = importlib.util.spec_from_file_location('probe', '/tmp/typd-gpu-check.py'); probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe); probe.run()"

cat > /tmp/typd-large-torch.py <<'PYTHON'
import gc
import json
import torch
assert torch.backends.mps.is_available(), 'MPS GPU is required'
chunks = []
for index in range(24):
    chunk = torch.empty((256 * 1024 * 1024,), dtype=torch.float32, device='mps')
    chunk.fill_(float(index + 1))
    chunks.append(chunk)
    torch.mps.synchronize()
for index, chunk in enumerate(chunks):
    assert chunk[0].item() == index + 1 and chunk[-1].item() == index + 1
allocated = torch.mps.current_allocated_memory()
assert allocated >= 24 * 1024**3
print(json.dumps({'pytorch_24_GiB_GPU_allocation_fill_readback': 'passed', 'allocated_bytes': allocated, 'torch': torch.__version__}))
del chunk, chunks
gc.collect()
torch.mps.empty_cache()
PYTHON
/tmp/typd-gpu-venv/bin/python /tmp/typd-large-torch.py
