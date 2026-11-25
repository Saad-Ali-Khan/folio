"""Persistent, private stdio worker. Images exist only in memory; one inference at a time."""
import base64
import contextlib
import json
import os
import queue
import sys
import threading
from pathlib import Path

protocol = sys.stdout


def emit(value):
    protocol.write(json.dumps(value, ensure_ascii=True) + '\n')
    protocol.flush()


def main():
    root = Path(__file__).resolve().parents[2] / '.folio-ocr'
    os.environ.setdefault('HF_HOME', str(root / 'cache' / 'huggingface'))
    os.environ.setdefault('XDG_CACHE_HOME', str(root / 'cache'))
    os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
    jobs = queue.Queue(maxsize=1)

    def read_requests():
        while True:
            line = sys.stdin.buffer.readline(18 * 1024 * 1024)
            if not line:
                os._exit(0)  # Also stops native inference if the owning bridge dies.
            if len(line) >= 18 * 1024 * 1024:
                os._exit(65)
            try:
                jobs.put_nowait(json.loads(line))
            except (ValueError, queue.Full):
                os._exit(65)

    threading.Thread(target=read_requests, daemon=True).start()
    with contextlib.redirect_stdout(sys.stderr):
        import cv2
        import numpy as np
        from paddleocr import PaddleOCR, TextRecognition
        engine = PaddleOCR(text_detection_model_name='PP-OCRv5_mobile_det',
                          text_recognition_model_name='en_PP-OCRv5_mobile_rec',
                          use_doc_orientation_classify=False, use_doc_unwarping=False,
                          use_textline_orientation=False, text_det_limit_type='max', text_det_limit_side_len=960,
                          text_recognition_batch_size=1, device='cpu', cpu_threads=2, enable_mkldnn=False)
        recognizer = None
    emit({'type': 'ready', 'engine': 'paddle-mobile', 'modelLoads': 1, 'protocol': 1})
    while True:
        request = jobs.get()
        watchdog = threading.Timer(25, lambda: os._exit(70))
        watchdog.daemon = True
        watchdog.start()
        try:
            mode = request['mode']
            if mode not in ('detect', 'recognize'):
                raise ValueError('Invalid mode')
            raw = base64.b64decode(request['image'], validate=True)
            if len(raw) > 12 * 1024 * 1024:
                raise ValueError('Image too large')
            image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None or max(image.shape[:2]) > 1600:
                raise ValueError('Invalid image dimensions')
            height, width = image.shape[:2]
            with contextlib.redirect_stdout(sys.stderr):
                if mode == 'recognize':
                    if recognizer is None:
                        recognizer = TextRecognition(model_name='en_PP-OCRv5_mobile_rec', device='cpu', cpu_threads=2, enable_mkldnn=False)
                    results = list(recognizer.predict(input=image, batch_size=1))
                else:
                    results = list(engine.predict(input=image))
            if len(results) != 1:
                raise ValueError('Invalid result count')
            payload = results[0].json
            if isinstance(payload, str):
                payload = json.loads(payload)
            record = payload.get('res', payload)
            if mode == 'recognize':
                result = {'text': record['rec_text'][:500], 'confidence': float(record['rec_score']) * 100}
            else:
                lines = []
                for text, score, polygon in zip(record['rec_texts'], record['rec_scores'], record['rec_polys']):
                    ys = [point[1] for point in polygon]
                    xs = [point[0] for point in polygon]
                    lines.append({'text': text[:500], 'confidence': float(score) * 100,
                                  'top': min(ys) / height, 'height': (max(ys) - min(ys)) / height, 'left': min(xs) / width})
                result = {'lines': sorted(lines[:500], key=lambda line: (line['top'], line['left']))}
            emit({'id': request['id'], 'result': result})
        except Exception:
            emit({'id': request.get('id'), 'error': 'Local OCR inference failed'})
        finally:
            watchdog.cancel()


if __name__ == '__main__':
    main()
