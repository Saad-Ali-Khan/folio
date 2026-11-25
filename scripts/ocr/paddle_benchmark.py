"""Read local photos and write local OCR results. Never contacts the app/database."""
import json
import hashlib
import os
import ctypes
import time
import resource
import argparse
from pathlib import Path
from importlib.metadata import version


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', choices=('mobile', 'stronger'), default='mobile')
    profile = parser.parse_args().profile
    try:
        ctypes.CDLL('libgomp.so.1')
    except OSError as error:
        raise SystemExit('Ubuntu OpenMP runtime is missing. Run: wsl --exec sudo apt-get install -y libgomp1') from error
    root = Path(__file__).resolve().parents[2] / '.folio-ocr'
    os.environ.setdefault('HF_HOME', str(root / 'cache' / 'huggingface'))
    os.environ.setdefault('XDG_CACHE_HOME', str(root / 'cache'))
    from paddleocr import PaddleOCR
    manifest = json.loads((root / 'cases.json').read_text(encoding='utf-8'))
    started = time.perf_counter()
    config = dict(
        text_detection_model_name='PP-OCRv5_mobile_det',
        text_recognition_model_name='PP-OCRv5_server_rec' if profile == 'stronger' else 'en_PP-OCRv5_mobile_rec',
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        text_det_limit_type='max', text_det_limit_side_len=960,
        text_recognition_batch_size=1,
        device='cpu', cpu_threads=2, enable_mkldnn=False,
    )
    output = root / ('paddle-stronger.json' if profile == 'stronger' else 'paddle.json')
    report = {'engine': 'PaddleOCR PP-OCRv5 mobile detector + server recognizer / CPU / max960' if profile == 'stronger'
              else 'PaddleOCR PP-OCRv5 mobile English / CPU / max960',
              'config': config, 'complete': False,
              'datasetHash': hashlib.sha256((root / 'cases.json').read_bytes()).hexdigest(),
              'versions': {name: version(name) for name in ('paddleocr', 'paddlepaddle')},
              'cases': []}
    output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    engine = PaddleOCR(**config)
    report['loadMs'] = round((time.perf_counter() - started) * 1000)
    for case in manifest:
        image = (root / case['image']).resolve()
        if not image.is_relative_to(root.resolve()):
            raise ValueError('Case image must stay inside the private trial folder')
        if hashlib.sha256(image.read_bytes()).hexdigest() != case['sha256']:
            raise ValueError(f"Input changed: {case['id']}")
        started = time.perf_counter()
        print(f"PaddleOCR reading {case['id']} ({profile}, detection max side 960, batch 1)", flush=True)
        results = list(engine.predict(input=str(image)))
        elapsed = round((time.perf_counter() - started) * 1000)
        if len(results) != 1:
            raise ValueError('Expected exactly one image result')
        payload = results[0].json
        if isinstance(payload, str):
            payload = json.loads(payload)
        record = payload.get('res', payload)
        width, height = case['width'], case['height']
        lines = []
        for text, score, polygon in zip(record['rec_texts'], record['rec_scores'], record['rec_polys']):
            ys = [point[1] for point in polygon]
            lines.append({'text': text, 'confidence': float(score) * 100,
                          'top': min(ys) / height, 'height': (max(ys) - min(ys)) / height,
                          'left': min(point[0] for point in polygon) / width})
        lines.sort(key=lambda line: (line['top'], line['left']))
        report['cases'].append({'id': case['id'], 'ocrMs': elapsed, 'lines': lines})
        report['peakRssMiB'] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f"PaddleOCR completed {case['id']}: {elapsed} ms, {len(lines)} text regions", flush=True)
    report['complete'] = True
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Local OCR complete. No books imported or stock changed.')


if __name__ == '__main__':
    main()
