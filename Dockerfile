# Neyra core: HTTP API + dashboard + resident modules (see server/main.py).
# Build: docker compose build
# Memory/Chroma and logs — volumes in docker-compose.yml.
FROM python:3.12-slim-bookworm

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ /app/

EXPOSE 8787

CMD ["python", "main.py"]
