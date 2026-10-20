from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from app.core.database import SessionLocal, create_all
from app.wecom.customer_service import poll_customer_service_once


def main() -> None:
    parser = argparse.ArgumentParser(description="Poll WeCom customer service messages and reply with the agent.")
    parser.add_argument("--interval", type=float, default=10.0, help="Polling interval in seconds.")
    parser.add_argument("--limit", type=int, default=100, help="Maximum messages per sync request.")
    parser.add_argument("--open-kfid", default="", help="Optional WeCom customer service open_kfid.")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    create_all()
    cursor = ""
    logging.info("Starting WeCom customer service polling.")
    while True:
        with SessionLocal() as db:
            try:
                cursor, replied_count = poll_customer_service_once(
                    db,
                    cursor=cursor,
                    limit=args.limit,
                    open_kfid=args.open_kfid,
                )
                logging.info("Synced customer service messages. replied=%s cursor=%s", replied_count, cursor)
            except Exception:
                logging.exception("Failed to poll WeCom customer service messages.")
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
