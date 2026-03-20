from flask import Flask, request, jsonify
from pdfminer.high_level import extract_text
import io
import os

app = Flask(__name__)

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
        return jsonify({ 'text': text })
    except Exception as e:
        return jsonify({ 'error': str(e) }), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
