# 🎬 CINEVERSE | Live AWS-Powered Movie Ticket Booking Platform

**CINEVERSE** is a high-performance, responsive movie ticket booking web application built with pure **HTML5, CSS3, and Vanilla JavaScript (ES6+)**. It connects directly to a live serverless backend hosted on **Amazon Web Services (AWS)** in the `ap-south-1` (Mumbai) region.

Designed with a cinematic midnight-charcoal aesthetic, crimson accents, subtle glassmorphism, dynamic seat maps, and instant digital ticketing, CINEVERSE is engineered for zero-dependency static deployment to **Amazon S3** and **Amazon CloudFront**.

---

## 📁 Project Structure

```text
MovieTicletBookingSystem/
├── index.html        # Semantic HTML5 structure, modals, accessibility tags & SVG graphics
├── style.css         # Custom CSS3 design system, responsive layouts & cinema animations
├── script.js         # Vanilla JS application engine, AWS API Gateway client & state manager
└── README.md         # Architecture, deployment guide, and troubleshooting documentation
```

> **Strict Framework-Free Architecture:** No React, Vue, Tailwind CSS, or Webpack/Vite bundlers. 100% standard web technologies, ready for instant S3 static website hosting.

---

## ☁️ AWS Backend Architecture & API Routes

The frontend interfaces with an AWS REST API Gateway deployed in `ap-south-1` (Mumbai):

* **API Gateway Base URL:** `https://jtajs6rkjk.execute-api.ap-south-1.amazonaws.com`
* **Underlying AWS Services:** AWS API Gateway &rarr; AWS Lambda &rarr; Amazon DynamoDB (Seats & Bookings) & Amazon SNS (Email Notifications).

### API Endpoints Implemented

| Method | Endpoint | Description | Payload / Query Parameters |
| :--- | :--- | :--- | :--- |
| `GET` | `/shows` | Fetches all scheduled movie screenings, screens, formats, and pricing tiers. | *None* |
| `GET` | `/seats?show_id={SHOW_ID}` | Queries real-time seat availability for a specific show from DynamoDB. | `show_id` (e.g. `avengers-2026-10-13-1800-screen1`) |
| `POST` | `/book-ticket` | Reserves a single seat atomically. | `{"show_id": "...", "seat_id": "A06", "customer": "John Doe", "email": "customer@example.com"}` |
| `POST` | `/book-group` | Reserves multiple seats in a single atomic transaction. | `{"show_id": "...", "seats": ["A06", "A07"], "customer": "John Doe", "email": "customer@example.com"}` |
| `GET` | `/tickets?email={EMAIL}` | Retrieves all active bookings linked to a customer's email. | `email` (URL-encoded via `encodeURIComponent`) |
| `DELETE` | `/ticket?show_id={SHOW_ID}&seat_id={SEAT_ID}` | Cancels an individual reservation and releases the seat. | `show_id` and `seat_id` query parameters |

---

## 🔒 Security Best Practices

> ⚠️ **STRICT WARNING REGARDING CREDENTIALS:**  
> **NEVER embed AWS IAM credentials, Access Keys (`AKIA...`), Secret Keys, or session tokens in frontend source code.**  
> CINEVERSE requires zero client-side credentials. All authentication, database queries, and notifications are handled securely server-side inside AWS Lambda behind API Gateway.

---

## 💻 Local Testing & Development

Because modern browsers enforce strict Cross-Origin Request policies on `file://` protocols, it is recommended to run a lightweight local HTTP server.

### Option 1: Python HTTP Server (Recommended)
```bash
# In the project directory:
python -m http.server 8000
```
Then open your browser at:
```text
http://localhost:8000
```

### Option 2: Node.js (via npx http-server)
```bash
npx http-server -p 8000
```

### Option 3: VS Code Live Server Extension
Right-click on `index.html` and select **"Open with Live Server"**.

---

## 🚀 Deployment to Amazon S3 (Static Website Hosting)

Follow these steps to host CINEVERSE on an existing or new Amazon S3 bucket:

### Step 1: Create or Select S3 Bucket
1. Open the [AWS S3 Console](https://s3.console.aws.amazon.com/).
2. Create a bucket with a unique name (e.g., `cineverse-movie-booking-demo`).
3. Select Region: **`ap-south-1` (Asia Pacific - Mumbai)**.
4. Under **Object Ownership**, choose **ACLs disabled (recommended)**.

### Step 2: Configure Public Read Permissions
1. In your bucket settings, uncheck **Block all public access** (for static website hosting).
2. Acknowledge the warning and click **Save changes**.
3. Under the **Permissions** tab &rarr; **Bucket policy**, paste the following policy (replace `YOUR-BUCKET-NAME`):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME/*"
    }
  ]
}
```

### Step 3: Enable Static Website Hosting
1. Go to the **Properties** tab.
2. Scroll to **Static website hosting** &rarr; Click **Edit**.
3. Select **Enable**.
4. Set **Index document** to: `index.html`.
5. Set **Error document** to: `index.html`.
6. Click **Save changes**. Note down the provided **Bucket website endpoint URL**.

### Step 4: Upload Application Files
Upload the following files to the root of the S3 bucket:
* `index.html`
* `style.css`
* `script.js`
* `README.md` (optional)

Using the AWS CLI:
```bash
aws s3 sync . s3://YOUR-BUCKET-NAME/ --exclude ".git/*" --acl public-read
```

---

## 🛠️ Troubleshooting Guide: AWS Serverless & CORS

### 1. Cross-Origin Resource Sharing (CORS) Issues
* **Symptom:** In the browser console: `Access to fetch at ... has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.`
* **Fix in AWS API Gateway:**
  1. Open **Amazon API Gateway Console** &rarr; Select API `jtajs6rkjk`.
  2. For each resource (`/shows`, `/seats`, `/book-ticket`, `/book-group`, `/tickets`, `/ticket`), click **Actions** &rarr; **Enable CORS**.
  3. Ensure `Access-Control-Allow-Origin` is set to `'*'` and allowed methods include `OPTIONS,GET,POST,DELETE`.
  4. Deploy the API: Click **Actions** &rarr; **Deploy API** &rarr; Select Stage.
* **Fix in AWS Lambda (Crucial for Proxy Integrations):**
  Lambda functions configured with Lambda Proxy Integration must explicitly return CORS headers in their HTTP response:
  ```json
  {
    "statusCode": 200,
    "headers": {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Methods": "OPTIONS,GET,POST,DELETE"
    },
    "body": "..."
  }
  ```

### 2. HTTP 409 Conflict (Duplicate Bookings)
* **Behavior:** If a seat was already reserved by another user, DynamoDB's conditional write prevents an overwrite and the API returns `409 Conflict`.
* **Frontend Handling:** CINEVERSE displays a warning banner and immediately triggers an automatic seat map refresh via `GET /seats?show_id=...` so the user sees newly unavailable seats without losing context.

### 3. Amazon SNS Email Notifications
* **Behavior:** When `email_notification_sent` is returned as `true`, an automated confirmation receipt was published to the SNS topic.
* **Note:** For email subscriptions in SNS sandbox mode, recipient addresses must confirm the AWS subscription email before messages are delivered to their inbox.

### 4. DynamoDB Conditional Writes & Rate Limits
* DynamoDB capacity throttling (HTTP 500/503) is handled gracefully by CINEVERSE with exponential timeouts (15s `AbortController`) and user-facing retry actions.

---

## 🧪 Verification & Acceptance Checklist

- [x] **Shows Feed (`GET /shows`):** Dynamically loads live screenings from AWS Gateway with filtering by movie title and format (IMAX, Dolby Atmos).
- [x] **Seat Map (`GET /seats`):** Renders seats grouped into Silver (₹180/₹200), Gold (₹250/₹280), Platinum (₹350/₹380), and Recliner (₹500/₹550). Booked seats (e.g. A01–A05) are strictly disabled.
- [x] **Single-Seat Reservation (`POST /book-ticket`):** Atomic booking with customer name and email validation.
- [x] **Multi-Seat Reservation (`POST /book-group`):** Group booking with dynamic subtotal calculations.
- [x] **Conflict Detection (409 Conflict):** Visual collision banners and seat-map re-synchronization.
- [x] **My Tickets (`GET /tickets`):** Customer email lookup with ticket grouped by booking ID and print-ready digital passes.
- [x] **Ticket Cancellation (`DELETE /ticket`):** Confirmation dialog with immediate state refresh.
- [x] **Accessibility & Visual Design:** Meets WCAG standards, keyboard navigation, high-contrast dark theme, and responsive mobile breakpoints.
