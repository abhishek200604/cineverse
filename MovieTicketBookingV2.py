
import json
import os
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer

# AWS clients and resources
dynamodb = boto3.resource("dynamodb")
sns = boto3.client("sns")
serializer = TypeSerializer()

TABLE_NAME = os.environ["TABLE_NAME"]
SNS_TOPIC_ARN = os.environ["SNS_TOPIC_ARN"]

table = dynamodb.Table(TABLE_NAME)
dynamodb_client = boto3.client("dynamodb")

# Demo schedule. Prices and valid shows are controlled by the backend.
SHOWS = [
    {
        "show_id": "avengers-2026-10-13-1800-screen1",
        "movie": "Avengers: Endgame",
        "date": "2026-10-13",
        "time": "6:00 PM",
        "screen": 1,
        "format": "IMAX",
        "prices": {
            "Silver": 180,
            "Gold": 250,
            "Platinum": 350,
            "Recliner": 500
        }
    },
    {
        "show_id": "avengers-2026-10-13-2100-screen2",
        "movie": "Avengers: Endgame",
        "date": "2026-10-13",
        "time": "9:00 PM",
        "screen": 2,
        "format": "Dolby Atmos",
        "prices": {
            "Silver": 180,
            "Gold": 250,
            "Platinum": 350,
            "Recliner": 500
        }
    },
    {
        "show_id": "interstellar-2026-10-13-1900-screen3",
        "movie": "Interstellar",
        "date": "2026-10-13",
        "time": "7:00 PM",
        "screen": 3,
        "format": "IMAX",
        "prices": {
            "Silver": 200,
            "Gold": 280,
            "Platinum": 380,
            "Recliner": 550
        }
    }
]

HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS"
}


def response(status, body):
    return {
        "statusCode": status,
        "headers": HEADERS,
        "body": json.dumps(body, default=str)
    }


def get_body(event):
    body = event.get("body")

    if not body:
        return {}

    if isinstance(body, dict):
        return body

    return json.loads(body)


def notify(subject, message):
    try:
        result = sns.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject=subject[:100],
            Message=message
        )
        print("SNS publish succeeded:", result.get("MessageId"))
        return True

    except Exception as exc:
        print("SNS PUBLISH FAILED:", repr(exc))
        return False


def find_show(show_id):
    for show in SHOWS:
        if show["show_id"] == show_id:
            return show
    return None


def seat_category(seat_id):
    if not isinstance(seat_id, str) or not seat_id:
        return None

    categories = {
        "A": "Silver",
        "B": "Silver",
        "C": "Gold",
        "D": "Gold",
        "E": "Platinum",
        "F": "Platinum",
        "G": "Recliner"
    }

    return categories.get(seat_id[0].upper())


def seat_price(show, seat_id):
    category = seat_category(seat_id)

    if not category:
        return None

    return category, show["prices"][category]


def valid_seat(seat_id):
    if not isinstance(seat_id, str) or len(seat_id) < 2:
        return False

    row = seat_id[0].upper()
    number = seat_id[1:]

    return (
        row in "ABCDEFG"
        and number.isdigit()
        and 1 <= int(number) <= 10
    )


def get_booked_seats(show_id):
    result = table.query(
        KeyConditionExpression=Key("show_id").eq(show_id),
        ProjectionExpression="seat_id"
    )

    seats = [item["seat_id"] for item in result.get("Items", [])]

    while result.get("LastEvaluatedKey"):
        result = table.query(
            KeyConditionExpression=Key("show_id").eq(show_id),
            ProjectionExpression="seat_id",
            ExclusiveStartKey=result["LastEvaluatedKey"]
        )

        seats.extend(
            item["seat_id"] for item in result.get("Items", [])
        )

    return seats


def make_booking_item(show, seat_id, booking_id, customer, email):
    category, price = seat_price(show, seat_id)

    return {
        "show_id": show["show_id"],
        "seat_id": seat_id,
        "booking_id": booking_id,
        "movie": show["movie"],
        "date": show["date"],
        "time": show["time"],
        "screen": show["screen"],
        "format": show["format"],
        "category": category,
        "price": Decimal(str(price)),
        "customer": customer,
        "email": email,
        "booked_at": datetime.now(timezone.utc).isoformat()
    }


def serialize_item(item):
    return {
        key: serializer.serialize(value)
        for key, value in item.items()
    }


def lambda_handler(event, context):
    try:
        request_context = event.get("requestContext") or {}
        http_context = request_context.get("http") or {}

        method = http_context.get("method")
        path = event.get("rawPath", "/")
        query = event.get("queryStringParameters") or {}

        # CORS preflight
        if method == "OPTIONS":
            return response(200, {"message": "CORS OK"})

        # GET /shows
        if method == "GET" and path.endswith("/shows"):
            return response(200, {"shows": SHOWS})

        # GET /seats?show_id=...
        if method == "GET" and path.endswith("/seats"):
            show_id = query.get("show_id")
            show = find_show(show_id)

            if not show:
                return response(400, {"error": "Invalid show_id"})

            booked = set(get_booked_seats(show_id))
            seats = []

            for row in "ABCDEFG":
                for number in range(1, 11):
                    seat_id = f"{row}{number:02d}"
                    category, price = seat_price(show, seat_id)

                    seats.append({
                        "seat_id": seat_id,
                        "category": category,
                        "price": price,
                        "available": seat_id not in booked
                    })

            return response(200, {
                "show": show,
                "seats": seats
            })

        # POST /book-ticket
        if method == "POST" and path.endswith("/book-ticket"):
            body = get_body(event)

            show_id = body.get("show_id")
            seat_id = str(body.get("seat_id", "")).upper()
            customer = body.get("customer", "").strip()
            email = body.get("email", "").strip()

            show = find_show(show_id)

            if (
                not show
                or not valid_seat(seat_id)
                or not customer
                or not email
            ):
                return response(400, {
                    "error": (
                        "Provide a valid show_id, seat_id, "
                        "customer and email"
                    )
                })

            booking_id = str(uuid.uuid4())

            item = make_booking_item(
                show, seat_id, booking_id, customer, email
            )

            try:
                table.put_item(
                    Item=item,
                    ConditionExpression="attribute_not_exists(seat_id)"
                )

            except dynamodb_client.exceptions.ConditionalCheckFailedException:
                return response(409, {
                    "error": "This seat is already booked for this show"
                })

            sent = notify(
                "Movie ticket booking confirmed",
                f"Hello {customer}, your booking is confirmed!\n"
                f"Movie: {show['movie']}\n"
                f"Date: {show['date']}\n"
                f"Time: {show['time']}\n"
                f"Screen: {show['screen']}\n"
                f"Format: {show['format']}\n"
                f"Seat: {seat_id}\n"
                f"Category: {item['category']}\n"
                f"Price: INR {item['price']}\n"
                f"Booking ID: {booking_id}"
            )

            return response(201, {
                "message": "Booking successful",
                "booking_id": booking_id,
                "show": show,
                "seat_id": seat_id,
                "category": item["category"],
                "price": int(item["price"]),
                "email_notification_sent": sent
            })

        # POST /book-group
        if method == "POST" and path.endswith("/book-group"):
            body = get_body(event)

            show_id = body.get("show_id")
            customer = body.get("customer", "").strip()
            email = body.get("email", "").strip()
            seats = body.get("seats", [])

            show = find_show(show_id)

            if not show or not customer or not email:
                return response(400, {
                    "error": "Invalid show or customer details"
                })

            if not isinstance(seats, list) or not seats or len(seats) > 50:
                return response(400, {
                    "error": "Select between 1 and 50 seats"
                })

            seats = [str(seat).upper() for seat in seats]

            if (
                len(set(seats)) != len(seats)
                or not all(valid_seat(seat) for seat in seats)
            ):
                return response(400, {
                    "error": "Invalid or duplicate seat selection"
                })

            booking_id = str(uuid.uuid4())
            items = []
            total = 0

            for seat_id in seats:
                item = make_booking_item(
                    show, seat_id, booking_id, customer, email
                )
                items.append(item)
                total += int(item["price"])

            # One atomic transaction: all seats book, or none do.
            transactions = []

            for item in items:
                transactions.append({
                    "Put": {
                        "TableName": TABLE_NAME,
                        "Item": serialize_item(item),
                        "ConditionExpression": (
                            "attribute_not_exists(#seat)"
                        ),
                        "ExpressionAttributeNames": {
                            "#seat": "seat_id"
                        }
                    }
                })

            try:
                dynamodb_client.transact_write_items(
                    TransactItems=transactions
                )

            except dynamodb_client.exceptions.TransactionCanceledException as exc:
                # Log the AWS cancellation reason for diagnosis.
                print("GROUP TRANSACTION CANCELLED:", repr(exc))
                cancellation_reasons = getattr(
                    exc, "response", {}
                ).get("CancellationReasons", [])
                print("CANCELLATION REASONS:", cancellation_reasons)

                return response(409, {
                    "error": (
                        "Group booking cancelled. One or more seats "
                        "may already be booked. Refresh the seat map."
                    )
                })

            except Exception as exc:
                print("GROUP TRANSACTION FAILED:", repr(exc))
                raise

            sent = notify(
                "Group movie booking confirmed",
                f"Hello {customer}, your group booking is confirmed!\n"
                f"Movie: {show['movie']}\n"
                f"Date: {show['date']}\n"
                f"Time: {show['time']}\n"
                f"Screen: {show['screen']}\n"
                f"Seats: {', '.join(seats)}\n"
                f"Tickets: {len(seats)}\n"
                f"Total: INR {total}\n"
                f"Booking ID: {booking_id}"
            )

            return response(201, {
                "message": "Group booking successful",
                "booking_id": booking_id,
                "show": show,
                "seats": seats,
                "total_tickets": len(seats),
                "total_price": total,
                "email_notification_sent": sent
            })

        # GET /tickets
        if method == "GET" and path.endswith("/tickets"):
            result = table.scan()
            items = result.get("Items", [])

            while result.get("LastEvaluatedKey"):
                result = table.scan(
                    ExclusiveStartKey=result["LastEvaluatedKey"]
                )
                items.extend(result.get("Items", []))

            return response(200, {"tickets": items})

        # DELETE /ticket?show_id=...&seat_id=...
        if method == "DELETE" and path.endswith("/ticket"):
            show_id = query.get("show_id")
            seat_id = (query.get("seat_id") or "").upper()

            if not find_show(show_id) or not valid_seat(seat_id):
                return response(400, {
                    "error": "Provide valid show_id and seat_id"
                })

            try:
                table.delete_item(
                    Key={
                        "show_id": show_id,
                        "seat_id": seat_id
                    },
                    ConditionExpression="attribute_exists(seat_id)"
                )

            except dynamodb_client.exceptions.ConditionalCheckFailedException:
                return response(404, {
                    "error": "No booking found for this seat"
                })

            return response(200, {
                "message": "Booking deleted",
                "show_id": show_id,
                "seat_id": seat_id
            })

        return response(404, {
            "error": "Route not found",
            "path": path,
            "method": method
        })

    except json.JSONDecodeError:
        return response(400, {"error": "Invalid JSON request body"})

    except Exception as exc:
        print("ERROR:", repr(exc))
        return response(500, {"error": "Internal server error"})
