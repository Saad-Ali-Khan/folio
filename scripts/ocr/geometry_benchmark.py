"""Bounded local crop experiment. No network calls except automatic model loading."""
import hashlib
import json
import os
import resource
import time
from pathlib import Path


def payload(result):
    data = result.json
    if isinstance(data, str):
        data = json.loads(data)
    return data.get('res', data)


def main():
    root = Path(__file__).resolve().parents[2] / '.folio-ocr'
    os.environ.setdefault('HF_HOME', str(root / 'cache' / 'huggingface'))
    os.environ.setdefault('XDG_CACHE_HOME', str(root / 'cache'))
    from paddleocr import PaddleOCR, TextRecognition
    data = (root / 'geometry-inputs.json').read_bytes()
    manifest = json.loads(data)
    baseline = json.loads((root / 'paddle.json').read_text())
    dataset_hash = hashlib.sha256((root / 'cases.json').read_bytes()).hexdigest()
    if not baseline['complete'] or baseline['datasetHash'] != dataset_hash or manifest['datasetHash'] != dataset_hash:
        raise ValueError('Stale or incomplete corpus/baseline')
    report = {'engine': 'PaddleOCR mobile + overlapping crops + direct rows / CPU / max960',
              'datasetHash': dataset_hash, 'viewsHash': hashlib.sha256(data).hexdigest(),
              'complete': False, 'cases': [],
              'config': {'detector': 'PP-OCRv5_mobile_det', 'recognizer': 'en_PP-OCRv5_mobile_rec',
                         'maxViews': 8, 'cpuThreads': 2, 'batch': 1, 'detectorMaxSide': 960}}
    output = root / 'paddle-geometry.json'
    output.write_text(json.dumps(report, indent=2))
    started = time.perf_counter()
    engine = PaddleOCR(text_detection_model_name='PP-OCRv5_mobile_det',
                      text_recognition_model_name='en_PP-OCRv5_mobile_rec',
                      use_doc_orientation_classify=False, use_doc_unwarping=False,
                      use_textline_orientation=False, text_det_limit_type='max', text_det_limit_side_len=960,
                      text_recognition_batch_size=1, device='cpu', cpu_threads=2, enable_mkldnn=False)
    recognizer = TextRecognition(model_name='en_PP-OCRv5_mobile_rec', device='cpu', cpu_threads=2, enable_mkldnn=False)
    report['loadMs'] = round((time.perf_counter() - started) * 1000)
    for case in manifest['cases']:
        base = next(row for row in baseline['cases'] if row['id'] == case['id'])
        lines = list(base['lines'])
        readings = []
        started = time.perf_counter()
        if len(case['views']) > 8:
            raise ValueError('View budget exceeded')
        for view in case['views']:
            image = (root / view['image']).resolve()
            if not image.is_relative_to(root.resolve()) or hashlib.sha256(image.read_bytes()).hexdigest() != view['sha256']:
                raise ValueError('Invalid or changed crop')
            if max(view['width'], view['height']) > 1200:
                raise ValueError('Crop dimensions exceed budget')
            if view['mode'] == 'recognize':
                results = list(recognizer.predict(input=str(image), batch_size=1))
                if len(results) != 1:
                    raise ValueError('Expected one line result')
                record = payload(results[0])
                line = dict(view['anchor'], text=record['rec_text'], confidence=float(record['rec_score']) * 100)
                observed = [line]
            else:
                results = list(engine.predict(input=str(image)))
                if len(results) != 1:
                    raise ValueError('Expected one crop result')
                record = payload(results[0])
                region = view['region']
                observed = []
                for text, score, polygon in zip(record['rec_texts'], record['rec_scores'], record['rec_polys']):
                    ys = [point[1] for point in polygon]
                    xs = [point[0] for point in polygon]
                    observed.append({'text': text, 'confidence': float(score) * 100,
                                     'top': (region['top'] + min(ys) * region['height'] / view['height']) / case['height'],
                                     'height': (max(ys) - min(ys)) * region['height'] / view['height'] / case['height'],
                                     'left': min(xs) / view['width']})
            lines.extend(observed)
            readings.append({'image': view['image'], 'mode': view['mode'], 'lines': observed})
        extra_ms = round((time.perf_counter() - started) * 1000)
        report['cases'].append({'id': case['id'], 'ocrMs': base['ocrMs'] + extra_ms,
                                'extraOcrMs': extra_ms, 'lines': lines, 'views': readings})
        report['peakRssMiB'] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(f"Crops complete: {case['id']}, {len(readings)} views, +{extra_ms}ms", flush=True)
    report['complete'] = True
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print('Complete. No inventory writes, Discord messages or bot changes.')


if __name__ == '__main__':
    main()
