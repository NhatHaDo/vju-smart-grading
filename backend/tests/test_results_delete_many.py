"""POST /results/delete-many (2026-10-06): "mấy nút xoá ở đây ko hoạt động" —
the Kết quả page deletes the chosen phiếu in ONE request instead of one
request per phiếu (a burst of hundreds was refused by the web server)."""


def _save(client, h, exam_id, n):
    items = [{"file_name": f"cham-nhanh_{exam_id}_{i}.jpg", "answers": {}} for i in range(n)]
    r = client.post("/api/v1/results/batch", json={"exam_id": exam_id, "items": items}, headers=h)
    assert r.status_code in (200, 201), r.text
    return r.json()["ids"]


def _exam(client, h, name):
    r = client.post("/api/v1/exams", json={"name": name}, headers=h)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_delete_many_in_one_request(client):
    h1, h2 = client.headers_for(1), client.headers_for(2)
    e1, e2 = _exam(client, h1, "Kỳ 1"), _exam(client, h2, "Kỳ 2")
    mine, theirs = _save(client, h1, e1, 250), _save(client, h2, e2, 3)

    # another teacher's phiếu and ids that don't exist are skipped
    r = client.post("/api/v1/results/delete-many", json={"ids": mine[:200] + theirs + [999999]}, headers=h1)
    assert r.status_code == 200 and r.json() == {"deleted": 200}
    left = client.get(f"/api/v1/results?exam_id={e1}", headers=h1).json()
    assert {x["id"] for x in left["items"]} == set(mine[200:])
    assert len(client.get(f"/api/v1/results?exam_id={e2}", headers=h2).json()["items"]) == 3

    # deleting again (already gone) is not an error
    r = client.post("/api/v1/results/delete-many", json={"ids": mine}, headers=h1)
    assert r.status_code == 200 and r.json() == {"deleted": 50}

    assert client.post("/api/v1/results/delete-many", json={"ids": theirs}).status_code in (401, 403)
