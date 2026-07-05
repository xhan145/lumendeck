import diffusers_backend as db


def test_is_available_is_bool():
    assert isinstance(db.is_available(), bool)


def test_generate_raises_clearly_when_unavailable():
    if db.is_available():
        return  # torch present in this env; skip the negative-path assertion
    try:
        db.generate({"prompt": "x", "seed": 1})
        assert False, "expected RuntimeError when diffusers/torch missing"
    except RuntimeError as exc:
        msg = str(exc).lower()
        assert "diffusers" in msg or "torch" in msg


def test_generate_falls_back_when_persistent_worker_exits():
    old_status = db.model_status
    old_persistent_worker = db._persistent_worker
    old_worker = db._worker

    class BrokenPersistentWorker:
        def request(self, command, payload, timeout=1800):
            raise RuntimeError("diffusers worker exited unexpectedly (see worker.log)")

    try:
        db.model_status = lambda: {"dependenciesReady": True}
        db._persistent_worker = BrokenPersistentWorker()
        db._worker = lambda command, payload, timeout=1800: {"image_base64": "ok", "seed": payload.get("seed")}

        out = db.generate({"prompt": "x", "seed": 7})

        assert out == {"image_base64": "ok", "seed": 7}
    finally:
        db.model_status = old_status
        db._persistent_worker = old_persistent_worker
        db._worker = old_worker


if __name__ == "__main__":
    test_is_available_is_bool()
    test_generate_raises_clearly_when_unavailable()
    test_generate_falls_back_when_persistent_worker_exits()
    print("diffusers backend: all checks passed")
