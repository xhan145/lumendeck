"""Tests for the GTX 1650 4GB low-VRAM worker helpers (no torch required).

These mirror the TS hardware module and cover: hardware detection, worker
precision selection, CUDA-OOM classification, and post-failure cleanup.
"""
import diffusers_backend as db


# --- fake torch, so detection is testable without a GPU (tests 4-7, 24-25) ---

class _FakeProps:
    def __init__(self, name, total_memory, major, minor):
        self.name = name
        self.total_memory = total_memory
        self.major = major
        self.minor = minor


class _FakeCuda:
    def __init__(self, available=True, props=None, free_mb=None, bf16=False, raise_on_available=False):
        self._available = available
        self._props = props
        self._free = free_mb
        self._bf16 = bf16
        self._raise = raise_on_available

    def is_available(self):
        if self._raise:
            raise RuntimeError("CUDA driver init failed")
        return self._available

    def get_device_properties(self, _idx):
        return self._props

    def mem_get_info(self):
        return (self._free * 1024 * 1024, self._props.total_memory)

    def is_bf16_supported(self):
        return self._bf16


class _FakeTorch:
    def __init__(self, cuda):
        self.cuda = cuda


def _gtx1650_torch():
    props = _FakeProps("NVIDIA GeForce GTX 1650", 4096 * 1024 * 1024, 7, 5)
    return _FakeTorch(_FakeCuda(available=True, props=props, free_mb=3600, bf16=False))


def test_detect_hardware_reads_gtx1650_vram_and_capability():
    info = db.detect_hardware(_gtx1650_torch())
    assert info["cuda"] is True
    assert info["cudaInitFailed"] is False
    assert info["gpuName"] == "NVIDIA GeForce GTX 1650"
    assert info["totalVramMb"] == 4096
    assert info["freeVramMb"] == 3600
    assert info["computeCapability"] == "7.5"
    assert info["bf16Supported"] is False


def test_detect_hardware_reports_no_cuda_without_gpu():
    info = db.detect_hardware(_FakeTorch(_FakeCuda(available=False)))
    assert info["cuda"] is False
    assert info["cudaInitFailed"] is False
    assert info["totalVramMb"] is None


def test_detect_hardware_flags_cuda_init_failure_without_raising():
    info = db.detect_hardware(_FakeTorch(_FakeCuda(raise_on_available=True)))
    assert info["cuda"] is False
    assert info["cudaInitFailed"] is True


# --- worker precision selection (test 8: unsupported precision fallback) ---

def test_worker_dtype_defaults_to_float16_on_cuda():
    assert db.worker_dtype_name({}, cuda=True) == "float16"


def test_worker_dtype_falls_back_to_float32_without_cuda():
    assert db.worker_dtype_name({"precision": "fp16"}, cuda=False) == "float32"


def test_worker_dtype_honors_explicit_fp32_request():
    assert db.worker_dtype_name({"precision": "fp32"}, cuda=True) == "float32"


def test_worker_dtype_never_uses_bf16_unless_hardware_confirms_it():
    assert db.worker_dtype_name({"precision": "bf16"}, cuda=True, bf16_supported=False) == "float16"
    assert db.worker_dtype_name({"precision": "bf16"}, cuda=True, bf16_supported=True) == "bfloat16"


# --- CUDA OOM classification (tests 16-18: do not swallow unrelated errors) ---

def test_is_cuda_oom_detects_torch_oom_messages():
    assert db.is_cuda_oom("CUDA out of memory. Tried to allocate 2.00 GiB") is True
    assert db.is_cuda_oom(RuntimeError("torch.cuda.OutOfMemoryError")) is True
    assert db.is_cuda_oom("CUBLAS_STATUS_ALLOC_FAILED") is True


def test_is_cuda_oom_ignores_unrelated_errors():
    assert db.is_cuda_oom("FileNotFoundError: model.safetensors") is False
    assert db.is_cuda_oom(ValueError("bad scheduler")) is False


# --- cleanup after a failed load / OOM (test 19) ---

def test_generate_surfaces_worker_oom_so_the_ui_can_retry():
    """A worker OOM (returned as a categorized error dict) must propagate as a
    RuntimeError whose message still names the OOM, so the server's fallbackReason
    carries it and the UI classifies it as cuda_oom for the single safe retry."""
    old_status = db.model_status
    old_worker = db._persistent_worker

    class OomWorker:
        def request(self, command, payload, timeout=1800):
            return {"error": "CUDA out of memory: the render exceeded the GPU memory budget.",
                    "errorCategory": "cuda_oom"}

    try:
        db.model_status = lambda: {"dependenciesReady": True}
        db._persistent_worker = OomWorker()
        raised = None
        try:
            db.generate({"prompt": "x", "seed": 1})
        except RuntimeError as exc:
            raised = exc
        assert raised is not None
        assert db.is_cuda_oom(raised) is True
    finally:
        db.model_status = old_status
        db._persistent_worker = old_worker


def test_release_gpu_refs_clears_all_model_references():
    state = {
        "pipe": object(),
        "anim_pipe": object(),
        "svd_pipe": object(),
        "key": "hub:sdxl",
        "anim_key": "anim:x",
        "svd_key": "svd:y",
        "lora_key": "[]",
        "controlnets": {"SD1.5:canny": object()},
    }
    db.release_gpu_refs(state)
    assert state["pipe"] is None
    assert state["anim_pipe"] is None
    assert state["svd_pipe"] is None
    assert state["key"] is None
    assert state["controlnets"] == {}


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("hardware worker helpers: all checks passed")
