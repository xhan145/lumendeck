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
    assert d["decode_chunk_size"] == 2 and d["seed"] == 0
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
