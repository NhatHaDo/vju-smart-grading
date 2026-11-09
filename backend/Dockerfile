FROM python:3.12-slim

# LibreOffice chỉ cần cho đề Word có công thức/hình (services/rich_objects.py).
# Build nhanh hơn / nhẹ hơn: --build-arg INSTALL_LIBREOFFICE=0
ARG INSTALL_LIBREOFFICE=1
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 fonts-dejavu-core curl \
    && if [ "$INSTALL_LIBREOFFICE" = "1" ]; then \
         apt-get install -y --no-install-recommends libreoffice-writer-nogui libreoffice-core; \
       fi \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# 1 worker: SQLite + init_db() chạy migrate khi khởi động, nhiều worker dễ khóa DB
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
