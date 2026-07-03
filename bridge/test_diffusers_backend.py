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


if __name__ == "__main__":
    test_is_available_is_bool()
    test_generate_raises_clearly_when_unavailable()
    print("diffusers backend: all checks passed")
