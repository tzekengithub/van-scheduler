from flask import Flask, request, jsonify
from pdfminer.high_level import extract_pages
from pdfminer.layout import LAParams, LTTextBox, LTTextLine
import io
import os

app = Flask(__name__)

def extract_text_by_position(pdf_bytes):
    """
    Extract text from PDF grouped by Y position (rows).
    This reads text in correct visual order regardless of
    column layout.
    """
    laparams = LAParams(
        line_overlap=0.5,
        char_margin=2.0,
        line_margin=0.5,
        word_margin=0.1,
        boxes_flow=0.5,
        detect_vertical=False,
        all_texts=True
    )

    text_elements = []

    for page_layout in extract_pages(
        io.BytesIO(pdf_bytes),
        laparams=laparams
    ):
        page_height = page_layout.height
        for element in page_layout:
            if isinstance(element, LTTextBox):
                for line in element:
                    if isinstance(line, LTTextLine):
                        text = line.get_text().strip()
                        if text:
                            # y position from top of page
                            y_pos = page_height - line.y1
                            x_pos = line.x0
                            text_elements.append({
                                'text': text,
                                'y': round(y_pos, 1),
                                'x': round(x_pos, 1)
                            })

    # Sort by Y position (top to bottom), then X (left to right)
    text_elements.sort(key=lambda e: (e['y'], e['x']))

    # Group elements on same line (within 5 units of Y)
    lines = []
    current_line = []
    current_y = None

    for elem in text_elements:
        if current_y is None or abs(elem['y'] - current_y) <= 5:
            current_line.append(elem['text'])
            current_y = elem['y']
        else:
            if current_line:
                lines.append(' '.join(current_line))
            current_line = [elem['text']]
            current_y = elem['y']

    if current_line:
        lines.append(' '.join(current_line))

    return '\n'.join(lines)


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
        text = extract_text_by_position(request.data)
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
        text = extract_text_by_position(request.data)
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
