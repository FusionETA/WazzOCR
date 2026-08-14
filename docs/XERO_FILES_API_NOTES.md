# Xero Files / Claims API Notes

This documents the claims upload flow that used to be in the UI, before removing that screen from the app.

## Purpose

The claims flow uploaded a receipt file to Xero Files, kept a small local record in `data/xero-files.json`, then optionally approved the claim by creating a draft Xero bill and associating the uploaded file with that bill.

## Internal App Endpoints

These were the Express routes used by the claims UI.

### Upload A Receipt To Xero Files

`POST /api/xero/files/upload`

Request type: `multipart/form-data`

Fields:

```text
file      required file field
supplier  optional string
amount    optional number
notes     optional string
```

Server behavior:

1. Reads the uploaded file from memory.
2. Calls `uploadToXeroFiles(fileBuffer, safeName, mimeType)`.
3. Creates/fetches a `Claims` folder in Xero Files.
4. Uploads the file to that folder, or to the Xero Files inbox if folder creation fails.
5. Saves a local record into `data/xero-files.json`.

Response shape:

```json
{
  "ok": true,
  "fileId": "xero-file-id",
  "url": "http://localhost:3000/api/xero/files/{fileId}/content",
  "record": {
    "fileId": "xero-file-id",
    "fileName": "receipt.jpg",
    "originalName": "receipt.jpg",
    "mimeType": "image/jpeg",
    "size": 12345,
    "url": "http://localhost:3000/api/xero/files/{fileId}/content",
    "supplier": "Supplier name",
    "amount": 123.45,
    "notes": "Optional notes",
    "status": "pending",
    "invoiceId": null,
    "invoiceNumber": null,
    "approvedAt": null,
    "uploadedAt": "ISO timestamp"
  }
}
```

### Stream An Uploaded Xero File

`GET /api/xero/files/:fileId/content`

Server behavior:

1. Loads/refreshes the saved Xero OAuth token.
2. Selects the active Xero tenant.
3. Calls Xero Files content API.
4. Streams the file bytes back to the browser without exposing the Bearer token.

### List Local Claim Records

`GET /api/xero/files`

Response shape:

```json
{
  "files": []
}
```

This only reads local records from `data/xero-files.json`. It does not query Xero for all files.

### Approve A Claim

`POST /api/xero/files/:fileId/approve`

Request type: `application/json`

Body:

```json
{
  "supplier": "Supplier name",
  "amount": 123.45,
  "notes": "Optional notes",
  "date": "2026-05-05",
  "currency": "MYR"
}
```

Server behavior:

1. Finds the local record in `data/xero-files.json`.
2. Creates a draft Xero bill using the existing `createDraftBill()` helper.
3. Associates the uploaded Xero File with the created Xero invoice/bill.
4. Marks the local record as `approved`.

## Underlying Xero API Calls

The app uses the Xero OAuth access token and selected tenant ID for every Xero Files call.

Required headers:

```http
Authorization: Bearer {access_token}
Xero-tenant-id: {tenant_id}
Accept: application/json
```

### List Folders

```http
GET https://api.xero.com/files.xro/1.0/Folders
```

Used to check if a `Claims` folder already exists.

### Create Folder

```http
POST https://api.xero.com/files.xro/1.0/Folders
Content-Type: application/json
```

Body:

```json
{
  "Name": "Claims"
}
```

If this fails, the old implementation uploaded to the root Xero Files inbox instead.

### Upload File To Folder

```http
POST https://api.xero.com/files.xro/1.0/Files/{folderId}
Content-Type: multipart/form-data; boundary={boundary}
```

If no folder ID is available:

```http
POST https://api.xero.com/files.xro/1.0/Files
```

Multipart part used by the old implementation:

```http
--{boundary}
Content-Disposition: form-data; name={safeFileName}; filename="{safeFileName}"
Content-Type: {mimeType}

{file bytes}
--{boundary}--
```

The response includes the Xero file object, including `Id`, `Name`, `MimeType`, `Size`, and folder info.

### Download / Proxy File Content

```http
GET https://api.xero.com/files.xro/1.0/Files/{fileId}/Content
```

The app proxied this through `/api/xero/files/:fileId/content` so the browser never received the OAuth token.

### Associate File With A Bill

```http
POST https://api.xero.com/files.xro/1.0/Files/{fileId}/Associations
Content-Type: application/json
```

Body:

```json
{
  "ObjectId": "{invoiceId}",
  "ObjectGroup": "Invoice"
}
```

In Xero, supplier bills are Accounts Payable invoices, so `ObjectGroup` was still sent as `Invoice`.

## Related Accounting API Call

Claim approval reused the app's bill creation flow:

```http
POST https://api.xero.com/api.xro/2.0/Invoices
```

The created invoice payload used:

```json
{
  "Type": "ACCPAY",
  "Status": "DRAFT",
  "Contact": { "ContactID": "{contactId}" },
  "DateString": "YYYY-MM-DD",
  "DueDateString": "YYYY-MM-DD",
  "InvoiceNumber": "optional",
  "CurrencyCode": "MYR",
  "Reference": "optional notes",
  "LineAmountTypes": "Exclusive",
  "LineItems": []
}
```

## Files To Look At If Rebuilding

- `server.js`: `getOrCreateClaimsFolder`, `uploadToXeroFiles`, `associateFileWithInvoice`
- `server.js`: old routes under `/api/xero/files...`
- `data/xero-files.json`: local metadata shape

## Important Implementation Notes

- Keep Xero access tokens server-side only.
- Proxy file downloads through your backend instead of exposing Bearer tokens to the browser.
- Sanitize filenames before upload.
- Keep a local database record if you need pending/approved claim status; Xero Files alone does not track your app-specific approval state.
- Ensure your Xero app scopes include the required accounting and files permissions for the APIs above.
