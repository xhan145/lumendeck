"""Civitai response-parsing tests (pure, no network)."""
import civitai

SAMPLE = {
    "items": [
        {
            "id": 1, "name": "Realistic Model", "type": "Checkpoint", "nsfw": False,
            "stats": {"downloadCount": 5000},
            "modelVersions": [
                {
                    "id": 42, "name": "v1", "baseModel": "SDXL 1.0",
                    "files": [
                        {"name": "vae.safetensors", "sizeKB": 300, "primary": False, "downloadUrl": "u0", "type": "VAE"},
                        {"name": "model.safetensors", "sizeKB": 6600000, "primary": True, "downloadUrl": "u1", "type": "Model"},
                    ],
                    "images": [{"url": "https://img/1.jpg"}],
                }
            ],
        },
        {"id": 2, "name": "No files", "type": "LORA", "modelVersions": [{"id": 7, "files": []}]},
    ]
}


def test_simplify_picks_primary_file_and_fields():
    rows = civitai.simplify(SAMPLE)
    assert len(rows) == 1  # the no-files model is skipped
    row = rows[0]
    assert row["name"] == "Realistic Model"
    assert row["versionId"] == 42
    assert row["fileName"] == "model.safetensors"      # primary, not the VAE
    assert row["downloadUrl"] == "u1"
    assert row["baseModel"] == "SDXL 1.0"
    assert row["thumbnail"] == "https://img/1.jpg"
    assert row["downloads"] == 5000


def test_simplify_handles_empty():
    assert civitai.simplify({}) == []
    assert civitai.simplify({"items": []}) == []


if __name__ == "__main__":
    test_simplify_picks_primary_file_and_fields()
    test_simplify_handles_empty()
    print("civitai parse: all checks passed")
