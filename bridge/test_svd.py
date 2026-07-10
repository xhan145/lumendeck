import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import diffusers_backend as db


def test_svd_target_size_orientation():
    assert db.svd_target_size(1200, 800) == (1024, 576)   # landscape
    assert db.svd_target_size(800, 1200) == (576, 1024)   # portrait
    assert db.svd_target_size(1000, 1000) == (1024, 576)  # square -> landscape default
    assert db.svd_target_size(0, 0) == (1024, 576)         # degenerate -> default


def test_clamp_svd_params_defaults_and_bounds():
    d = db.clamp_svd_params({})
    assert d["num_frames"] == 14 and d["fps"] == 7 and d["motion_bucket_id"] == 127
    assert d["decode_chunk_size"] == 2 and d["seed"] == 0 and d["num_inference_steps"] == 25
    assert db.clamp_svd_params({"num_inference_steps": 999})["num_inference_steps"] == 50
    hi = db.clamp_svd_params({"num_frames": 999, "fps": 999, "motion_bucket_id": 999, "decode_chunk_size": 999, "seed": -5})
    assert hi["num_frames"] == 25 and hi["fps"] == 30 and hi["motion_bucket_id"] == 255
    assert hi["decode_chunk_size"] == 8 and hi["seed"] == 0
    lo = db.clamp_svd_params({"num_frames": 1, "fps": 0, "motion_bucket_id": 0, "decode_chunk_size": 0})
    assert lo["num_frames"] == 8 and lo["fps"] == 1 and lo["motion_bucket_id"] == 1 and lo["decode_chunk_size"] == 1


def test_is_svd_model_folder(tmp_path):
    d = tmp_path / "svd-img2vid"
    d.mkdir()
    (d / "model_index.json").write_text(json.dumps({"_class_name": "StableVideoDiffusionPipeline"}))
    assert db.is_svd_model(str(d)) is True
    other = tmp_path / "sdxl"
    other.mkdir()
    (other / "model_index.json").write_text(json.dumps({"_class_name": "StableDiffusionXLPipeline"}))
    assert db.is_svd_model(str(other)) is False


def test_is_svd_model_singlefile(tmp_path):
    f = tmp_path / "svd_xt.safetensors"
    f.write_bytes(b"x")
    assert db.is_svd_model(str(f)) is True
    g = tmp_path / "dreamshaper.safetensors"
    g.write_bytes(b"x")
    assert db.is_svd_model(str(g)) is False


def test_find_svd_models(tmp_path):
    (tmp_path / "svd-img2vid").mkdir()
    (tmp_path / "svd-img2vid" / "model_index.json").write_text(json.dumps({"_class_name": "StableVideoDiffusionPipeline"}))
    (tmp_path / "svd.safetensors").write_bytes(b"x")
    (tmp_path / "notmodel").mkdir()
    found = db.find_svd_models(str(tmp_path))
    paths = {os.path.basename(m["path"]) for m in found}
    assert "svd-img2vid" in paths and "svd.safetensors" in paths
    assert all("id" in m and "name" in m and m["kind"] in ("folder", "file") for m in found)
    assert db.find_svd_models(str(tmp_path / "missing")) == []


def test_find_svd_models_recursive_and_nested(tmp_path):
    # The common ComfyUI/Fooocus layout: models/checkpoints/svd_xt.safetensors (nested).
    ckpt = tmp_path / "checkpoints"
    ckpt.mkdir()
    (ckpt / "svd_xt.safetensors").write_bytes(b"x")
    # A nested diffusers SVD folder (InvokeAI-ish).
    nested = tmp_path / "video" / "svd-img2vid"
    nested.mkdir(parents=True)
    (nested / "model_index.json").write_text(json.dumps({"_class_name": "StableVideoDiffusionPipeline"}))
    found = db.find_svd_models(str(tmp_path))
    bases = {os.path.basename(m["path"]) for m in found}
    assert "svd_xt.safetensors" in bases and "svd-img2vid" in bases


def test_find_svd_models_none_is_empty():
    assert db.find_svd_models(None) == []


def test_is_svd_model_tolerates_nonobject_index(tmp_path):
    d = tmp_path / "weird"
    d.mkdir()
    (d / "model_index.json").write_text(json.dumps(["not", "an", "object"]))
    assert db.is_svd_model(str(d)) is False  # no crash


def test_worker_source_defines_svd_helpers():
    # The code that ACTUALLY runs SVD lives inside the _WORKER_SOURCE string; exec it in
    # an isolated namespace and check the helpers exist + clamp identically to the
    # module-level copy (the two must stay in sync).
    ns = {}
    exec(compile(db._WORKER_SOURCE, "<worker>", "exec"), ns)
    assert "_animate_svd" in ns and callable(ns["_animate_svd"])
    assert ns["_svd_target_size"](800, 1200) == (576, 1024)
    assert ns["_svd_target_size"](1200, 800) == (1024, 576)
    got = ns["_clamp_svd"]({"num_frames": 999, "fps": 0})
    assert got["num_frames"] == 25 and got["fps"] == 1 and got["motion_bucket_id"] == 127


def test_module_forwarder_animate_svd_exists():
    assert hasattr(db, "animate_svd") and callable(db.animate_svd)
