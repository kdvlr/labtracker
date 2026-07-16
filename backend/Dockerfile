FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

ARG COMMIT_SHA=unknown
ENV COMMIT_SHA=$COMMIT_SHA
RUN echo $COMMIT_SHA > /app/commit_sha.txt

COPY app ./app
COPY static ./static

ENV LABTRACKER_DATA=/data
VOLUME /data
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

