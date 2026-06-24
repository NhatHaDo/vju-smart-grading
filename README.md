# VJU Smart Grading

Hệ thống chấm thi trắc nghiệm tự động sử dụng OMR (Optical Mark Recognition).

## Stack

| Layer | Tech |
|---|---|
| Frontend | Vite + React + TypeScript + Tailwind CSS |
| Backend | FastAPI + SQLAlchemy + SQLite |
| OMR Core | OpenCV (ported từ OMRChecker) |
| Auth | JWT (access + refresh token) + bcrypt |

## Cấu trúc

```
vju-smart-grading/
├── frontend/          # Vite + React + TypeScript
├── backend/           # FastAPI layered architecture
│   └── app/
│       ├── api/v1/routes/
│       ├── services/
│       ├── repositories/
│       ├── models/
│       ├── schemas/
│       └── core/omr/
├── docs/
├── scripts/
└── .env.example
```

## Cài đặt & Chạy

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp ../.env.example .env
uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
cp ../.env.example .env.local
npm run dev
```

Frontend chạy tại http://localhost:5173 — Backend tại http://localhost:8000
