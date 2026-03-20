from flask import Flask, request, jsonify
from pdfminer.high_level import extract_text
import io
import os

app = Flask(__name__)

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
        pdf_buffer = io.BytesIO(request.data)
        text = extract_text(pdf_buffer)
        if not text or len(text.strip()) < 10:
            return jsonify({ 'error': 'Could not extract text from PDF' }), 422
        return jsonify({ 'text': text })
    except Exception as e:
        return jsonify({ 'error': str(e) }), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port)
