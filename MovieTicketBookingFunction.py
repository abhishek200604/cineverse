
import json
import os
import base64
import boto3
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")
sns = boto3.client("sns")

table = dynamodb.Table(os.environ["TABLE_NAME"])
topic_arn = os.environ["SNS_TOPIC_ARN"]


def response(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS"
        },
        "body": json.dumps(body, default=str)
    }


def get_body(event):
    body = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    return json.loads(body)


def send_notification(subject, message):
    try:
        result = sns.publish(
            TopicArn=topic_arn,
            Subject=subject,
            Message=message
        )
        print("SNS publish succeeded:", result.get("MessageId"))
        return True
    except Exception as e:
        print("SNS PUBLISH FAILED:", repr(e))
        return False


def lambda_handler(event, context):
    method = event.get("httpMethod") or event.get(
        "requestContext", {}
    ).get("http", {}).get("method")

    path = event.get("path") or event.get("rawPath", "")

    if method == "OPTIONS":
        return response(200, {"message": "OK"})

    try:
        # POST /book-group
        if method == "POST" and path.endswith("/book-group"):
            data = get_body(event)

            movie = str(data.get("movie", "")).strip()
            show = str(data.get("show", "")).strip()
            customer = str(data.get("customer", "")).strip()
            email = str(data.get("email", "")).strip()
            seats = data.get("seats")

            if (
                not movie or not show or not customer
                or not isinstance(seats, list) or not seats
            ):
                return response(400, {
                    "error": "movie, show, customer and a non-empty seats list are required"
                })

            seats = [str(s).strip().upper() for s in seats]

            if any(not seat for seat in seats):
                return response(400, {
                    "error": "Seat names cannot be empty"
                })

            if len(set(seats)) != len(seats):
                return response(400, {
                    "error": "The seats list contains duplicates"
                })

            if len(seats) > 100:
                return response(400, {
                    "error": "A group booking can contain at most 100 seats"
                })

            bookings = []
            transact_items = []

            for seat in seats:
                booking = {
                    "seat": seat,
                    "movie": movie,
                    "show": show,
                    "customer": customer
                }

                if email:
                    booking["email"] = email

                bookings.append(booking)
                transact_items.append({
                    "Put": {
                        "TableName": table.name,
                        "Item": booking,
                        "ConditionExpression": "attribute_not_exists(#s)",
                        "ExpressionAttributeNames": {"#s": "seat"}
                    }
                })

            # All seats succeed together, or none are reserved.
            dynamodb.meta.client.transact_write_items(
                TransactItems=transact_items
            )

            seat_list = ", ".join(seats)
            message = (
                "Group Movie Ticket Booking Confirmation\n\n"
                f"Movie: {movie}\n"
                f"Show: {show}\n"
                f"Customer: {customer}\n"
                f"Seats: {seat_list}\n"
                f"Total tickets: {len(seats)}\n"
                f"Email provided: {email or 'Not provided'}"
            )

            notified = send_notification(
                "Group Movie Ticket Booking Confirmation",
                message
            )

            return response(201, {
                "message": "Group booking successful",
                "movie": movie,
                "show": show,
                "total_tickets": len(bookings),
                "bookings": bookings,
                "email_notification_sent": notified
            })

        # POST /book-ticket
        if method == "POST" and path.endswith("/book-ticket"):
            data = get_body(event)

            movie = str(data.get("movie", "")).strip()
            seat = str(data.get("seat", "")).strip().upper()
            customer = str(data.get("customer", "")).strip()
            email = str(data.get("email", "")).strip()

            if not movie or not seat or not customer:
                return response(400, {
                    "error": "movie, seat and customer are required"
                })

            booking = {
                "seat": seat,
                "movie": movie,
                "customer": customer
            }

            if email:
                booking["email"] = email

            table.put_item(
                Item=booking,
                ConditionExpression="attribute_not_exists(#s)",
                ExpressionAttributeNames={"#s": "seat"}
            )

            message = (
                f"Movie: {movie}\n"
                f"Seat: {seat}\n"
                f"Customer: {customer}\n"
                f"Email: {email or 'Not provided'}"
            )

            notified = send_notification(
                "Movie Ticket Booking Confirmation", message
            )

            return response(201, {
                "message": "Ticket booked successfully",
                "booking": booking,
                "email_notification_sent": notified
            })

        # GET /tickets
        if method == "GET" and path.endswith("/tickets"):
            result = table.scan()
            tickets = result.get("Items", [])

            while result.get("LastEvaluatedKey"):
                result = table.scan(
                    ExclusiveStartKey=result["LastEvaluatedKey"]
                )
                tickets.extend(result.get("Items", []))

            return response(200, {
                "count": len(tickets),
                "tickets": tickets
            })

        # DELETE /ticket?seat=A12
        if method == "DELETE" and path.endswith("/ticket"):
            params = event.get("queryStringParameters") or {}
            seat = str(params.get("seat", "")).strip().upper()

            if not seat:
                return response(400, {
                    "error": "Provide a seat query parameter"
                })

            result = table.delete_item(
                Key={"seat": seat},
                ConditionExpression="attribute_exists(#s)",
                ExpressionAttributeNames={"#s": "seat"},
                ReturnValues="ALL_OLD"
            )

            return response(200, {
                "message": "Ticket cancelled successfully",
                "booking": result.get("Attributes", {})
            })

        return response(404, {
            "error": "Route not found",
            "method": method,
            "path": path
        })

    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        print("AWS service error:", repr(e))

        if code == "ConditionalCheckFailedException":
            if method == "POST":
                return response(409, {
                    "error": "This seat is already booked"
                })

            if method == "DELETE":
                return response(404, {
                    "error": "No booking found for this seat"
                })

        if code == "TransactionCanceledException":
            return response(409, {
                "error": "Group booking failed. One or more seats may already be booked; no seats from this group were reserved."
            })

        return response(500, {
            "error": "AWS service operation failed"
        })

    except Exception as e:
        print("Unexpected error:", repr(e))
        return response(500, {
            "error": "Internal server error"
        })
