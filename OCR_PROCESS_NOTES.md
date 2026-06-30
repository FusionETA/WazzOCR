# OCR Process Notes

This project uses OCR and AI together to turn receipt or invoice images into structured bill data that can be reviewed and sent to Xero.

## Main Idea

OCR extracts readable text from an image or document.

AI intelligence understands that text and converts it into business data, such as supplier name, invoice number, date, line items, tax, total amount, and notes.

The OCR step answers: "What text is on the document?"

The AI step answers: "What does this text mean as a bill or invoice?"

## Browser Upload Flow

The browser upload flow is handled in `index.html`.

1. The user uploads a bill, receipt, or invoice image.
2. Tesseract.js reads the image in the browser.
3. Tesseract.js returns raw OCR text.
4. The raw OCR text is sent to the Node server endpoint `/api/ai/analyze-bill`.
5. The selected AI provider, Groq or Gemini, analyzes the OCR text.
6. The AI returns structured JSON bill data.
7. The page displays the structured bill.
8. If Xero is connected, the app can create a Xero draft bill from the structured data.

## How Tesseract.js Is Used

Tesseract.js is loaded in `index.html` from a CDN:

```html
<script src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"></script>
```

The actual OCR call happens in the `scanBill()` function:

```js
const { data: { text: rawText } } = await Tesseract.recognize(billCurrentFile, 'eng', {
  logger: m => {
    if (m.status === 'recognizing text')
      document.getElementById('billProgressFill').style.width = Math.round(m.progress * 33) + '%';
  }
});
```

Tesseract.js responsibilities:

- Read the uploaded image file.
- Detect printed English text from the image.
- Return plain raw text.
- Report recognition progress so the UI can update the progress bar.

Tesseract.js does not understand invoices by itself. It does not know which text is the supplier, total, tax, or invoice number. It only extracts text.

## How AI Intelligence Is Used

The AI analysis is handled mainly in `server.js`.

The browser sends raw OCR text to:

```txt
POST /api/ai/analyze-bill
```

The server then calls:

```js
analyzeBillText({ text, provider, model })
```

The app supports these AI providers:

- Groq
- Gemini

The AI receives a prompt from `buildBillPrompt(ocrText)`. The prompt tells the model to return only valid JSON in this structure:

```json
{
  "supplier": "Company name or null",
  "invoiceNo": "Invoice number or null",
  "date": "Date string or null",
  "dueDate": "Due date string or null",
  "currency": "MYR/USD/SGD etc, default MYR",
  "lineItems": [
    {
      "description": "string",
      "qty": 1,
      "unitPrice": 0.00,
      "amount": 0.00
    }
  ],
  "subtotal": 0.00,
  "tax": 0.00,
  "taxLabel": "SST/GST/VAT/Tax",
  "discount": 0.00,
  "total": 0.00,
  "notes": "string or null"
}
```

AI responsibilities:

- Understand messy OCR text.
- Identify whether the document is a bill, receipt, or invoice.
- Extract important accounting fields.
- Convert text into structured JSON.
- Infer missing structure when the OCR text is not perfectly formatted.
- Normalize the result before sending it back to the browser.

## WhatsApp Webhook Flow

The WhatsApp webhook flow is handled in `webhook.php`.

This flow is different from the browser upload flow.

For WhatsApp images and PDFs, the webhook sends the file directly to Gemini with the file data attached. Gemini performs both OCR and document understanding.

The webhook flow is:

1. Wazzup sends a WhatsApp message to `webhook.php`.
2. If the message contains an image or PDF, the file is downloaded.
3. The file is sent to Gemini using `call_gemini_with_file()`.
4. Gemini extracts text and formats invoice-like documents.
5. The extracted text is sent to the local Node bridge at `/api/whatsapp/analyze-ocr`.
6. The Node server uses Groq or Gemini to convert the text into structured bill JSON.
7. If enabled, the Node server can create a Xero draft bill.
8. The result is sent back to the WhatsApp user.

Important note:

- Browser upload uses Tesseract.js for OCR first, then AI for bill understanding.
- WhatsApp upload uses Gemini vision for OCR and document understanding, then the Node AI bridge for structured bill analysis.

## Why Both OCR and AI Are Needed

Tesseract.js is good at reading visible text from images, but the output can be messy.

Example raw OCR text may look like this:

```txt
ABC SDN BHD
INV-1029
Date 05/05/2026
SST 8.00
TOTAL RM108.00
```

The AI converts that into usable bill data:

```json
{
  "supplier": "ABC SDN BHD",
  "invoiceNo": "INV-1029",
  "date": "05/05/2026",
  "currency": "MYR",
  "subtotal": 100,
  "tax": 8,
  "total": 108
}
```

Together, the flow is:

```txt
Image or PDF
    -> OCR text extraction
    -> AI bill understanding
    -> Structured JSON
    -> Review in UI
    -> Optional Xero draft bill
```

## Environment Keys

The AI API keys are stored server-side in `.env`, not in the browser.

Common keys:

```txt
GROQ_API_KEY=...
GEMINI_API_KEY=...
DEFAULT_AI_PROVIDER=groq
```

Xero keys and tokens are also handled by the Node server so the browser does not directly access Xero secrets.

## Summary

Tesseract.js is the text reader.

AI intelligence is the document analyst.

Xero is the accounting destination.

The project combines all three so a user can upload or send a receipt, extract the text, understand the bill details, and create a draft bill in Xero.
