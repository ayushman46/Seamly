import io

from fastapi.testclient import TestClient

from bowlnet.api import app

client = TestClient(app)


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["ok"] is True


def test_rejects_non_video_upload():
    r = client.post("/api/analyses", files={"file": ("notes.txt", io.BytesIO(b"hello"), "text/plain")})
    assert r.status_code == 400 and "Unsupported" in r.json()["detail"]


def test_rejects_empty_upload():
    r = client.post("/api/analyses", files={"file": ("x.mp4", io.BytesIO(b""), "video/mp4")})
    assert r.status_code == 400


def test_unknown_and_malformed_ids():
    assert client.get("/api/analyses/0123456789ab").status_code == 404
    assert client.get("/api/analyses/xyz").status_code == 404
    assert client.get("/api/does-not-exist").status_code == 404
    # traversal attempts never escape the frontend build
    for path in ["/..%2F..%2Fbackend%2Fbowlnet%2Fconfig.py", "/%2e%2e/%2e%2e/backend/bowlnet/config.py"]:
        r = client.get(path)
        assert "MODELS_DIR" not in r.text
    assert client.get("/api/analyses/zzz/frames/1.jpg").status_code == 404


def test_list_is_a_list():
    r = client.get("/api/analyses")
    assert r.status_code == 200 and isinstance(r.json(), list)


def test_rejects_bad_height():
    for h in ("nan", "500", "-1"):
        r = client.post("/api/analyses", data={"height_cm": h},
                        files={"file": ("x.mp4", io.BytesIO(b"\0" * 100), "video/mp4")})
        assert r.status_code in (400, 422), (h, r.status_code)


def test_edits_need_a_finished_analysis():
    from bowlnet import store
    aid = store.new_id()
    (store.root() / aid).mkdir()
    try:
        store.write_meta(aid, id=aid, name="t", created=0, status="failed", options={})
        assert client.post(f"/api/analyses/{aid}/reset").status_code == 409
        assert client.post(f"/api/analyses/{aid}/recompute", json={"events": {"br": 3}}).status_code == 409
        assert client.get(f"/api/analyses/{aid}/export/json").status_code == 409
    finally:
        store.delete(aid)


def test_demo_is_rendered_once_and_queued(tmp_path, monkeypatch):
    from bowlnet import api, config, jobs
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "ANALYSES_DIR", tmp_path / "analyses")
    queued = []
    monkeypatch.setattr(jobs, "submit", queued.append)
    ids = [client.post("/api/demo").json()["id"] for _ in range(2)]
    assert queued == ids and ids[0] != ids[1]
    assert (tmp_path / "demo" / "synthetic_side_60fps.mp4").stat().st_size > 100_000
    for aid in ids:
        assert (tmp_path / "analyses" / aid / "input.mp4").exists()
        assert client.get(f"/api/analyses/{aid}").json()["meta"]["status"] == "queued"
    assert api.config.ANALYSES_DIR == tmp_path / "analyses"


def test_app_shell_is_revalidated_and_assets_are_immutable():
    r = client.get("/")
    if r.status_code != 200 or "<html" not in r.text.lower():
        return   # frontend not built
    assert r.headers.get("cache-control") == "no-cache"
    import re
    asset = re.search(r'/assets/[^"]+\.js', r.text).group(0)
    a = client.get(asset)
    assert a.status_code == 200 and "immutable" in a.headers.get("cache-control", "")


def test_head_on_api_routes_is_not_a_404():
    assert client.head("/api/health").status_code == 405
    assert client.get("/api/health").status_code == 200
