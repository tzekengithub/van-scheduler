from flask import Flask, request, jsonify
import fitz  # PyMuPDF
import io
import os

app = Flask(__name__)

def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    full_text = []

    for page in doc:
        # Extract text blocks with position info
        blocks = page.get_text("blocks")

        # Sort blocks top to bottom, left to right
        blocks.sort(key=lambda b: (round(b[1] / 5) * 5, b[0]))

        for block in blocks:
            text = block[4].strip()
            if text:
                full_text.append(text)

    doc.close()
    return '\n'.join(full_text)


@app.route('/', methods=['GET'])
def index():
    return jsonify({ 'status': 'ok', 'service': 'pdf-parser' })

@app.route('/health', methods=['GET'])
def health():
    return jsonify({ 'status': 'ok' })

@app.route('/parse', methods=['POST'])
def parse_pdf():
    if not request.data:
        return jsonify({ 'error': 'No PDF data received' }), 400
    try:
        text = extract_text_from_pdf(request.data)
        if not text or len(text.strip()) < 10:
            return jsonify({
                'error': 'Could not extract text from PDF'
            }), 422
        return jsonify({ 'text': text })
    except Exception as e:
        return jsonify({ 'error': str(e) }), 500

@app.route('/debug', methods=['POST'])
def debug_pdf():
    if not request.data:
        return jsonify({ 'error': 'No PDF data' }), 400
    try:
        text = extract_text_from_pdf(request.data)
        lines = text.split('\n')
        return jsonify({
            'lines': lines,
            'total_lines': len(lines)
        })
    except Exception as e:
        return jsonify({ 'error': str(e) }), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port)
