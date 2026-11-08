FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app/api
COPY api/pyproject.toml api/uv.lock* ./
RUN uv sync --no-dev --extra postgres --no-install-project
COPY api/ ./
COPY data/ /app/data/
EXPOSE 8000
CMD ["uv", "run", "--no-dev", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
