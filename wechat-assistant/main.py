import argparse

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="Start the training customer-service agent.")
    parser.add_argument("--host", default="127.0.0.1", help="API bind host.")
    parser.add_argument("--port", default=8000, type=int, help="API bind port.")
    parser.add_argument("--no-reload", action="store_true", help="Disable FastAPI auto-reload.")
    parser.add_argument("--worker", action="store_true", help="Start the Celery worker instead of the API.")
    args = parser.parse_args()

    if args.worker:
        from app.core.celery_app import celery_app

        celery_app.worker_main(["worker", "--loglevel=info", "--pool=solo"])
        return

    uvicorn.run("app.main:app", host=args.host, port=args.port, reload=not args.no_reload)


if __name__ == "__main__":
    main()
