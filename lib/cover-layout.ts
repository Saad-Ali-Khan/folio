import sharp from "sharp";

/** Isolate the dominant lettering without dropping the original mixed-size view. */
export async function dominantCoverLine(binary: Buffer, width: number, top: number, height: number) {
  const mask = await sharp(binary).extract({ left: 0, top, width, height }).toColourspace("b-w").raw().toBuffer();
  const seen = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  const components: { pixels: number[]; height: number }[] = [];
  for (let seed = 0; seed < mask.length; seed++) {
    if (mask[seed] !== 0 || seen[seed]) continue;
    let head = 0, size = 1, minY = height, maxY = 0;
    queue[0] = seed; seen[seed] = 1;
    while (head < size) {
      const pixel = queue[head++], x = pixel % width, y = Math.floor(pixel / width);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (mask[next] === 0 && !seen[next]) { seen[next] = 1; queue[size++] = next; }
      }
    }
    components.push({ pixels: Array.from(queue.subarray(0, size)), height: maxY - minY + 1 });
  }
  const largest = components.reduce((largest, component) => Math.max(largest, component.height), 0);
  if (!largest) return null;
  for (const component of components) if (component.height < largest * 0.5) {
    for (const pixel of component.pixels) mask[pixel] = 255;
  }
  return sharp(mask, { raw: { width, height, channels: 1 } }).trim({ background: "white" })
    .resize({ height: 64 }).extend({ top: 10, bottom: 10, left: 10, right: 10, background: "white" }).png().toBuffer();
}

/** Local contrast separates printed lettering from uneven lighting on a cover. */
export async function coverTextBands(prepared: Buffer, width: number, height: number) {
  if (width < 16 || height < 16) return { binary: prepared, left: 0, width, bands: [] };
  const left = Math.floor(width * 0.07);
  const innerWidth = Math.floor(width * 0.83);
  const region = { left, top: 0, width: innerWidth, height };
  const raw = await sharp(prepared).extract(region).toColourspace("b-w").raw().toBuffer();
  const background = await sharp(prepared).extract(region).blur(16).toColourspace("b-w").raw().toBuffer();
  const mask = Buffer.alloc(raw.length, 255);
  const bands: { from: number; to: number }[] = [];
  for (let i = 0; i < raw.length; i++) if (background[i] - raw[i] > 18) mask[i] = 0;
  // Connected cover borders can run through several rows. Remove those tall
  // components before detecting rows; raising the ink threshold clips serifs.
  const visited = new Uint8Array(mask.length);
  const component = new Int32Array(mask.length);
  for (let seed = 0; seed < mask.length; seed++) {
    if (mask[seed] !== 0 || visited[seed]) continue;
    let head = 0, size = 1, minY = height, maxY = 0;
    component[0] = seed; visited[seed] = 1;
    while (head < size) {
      const pixel = component[head++], y = Math.floor(pixel / innerWidth), x = pixel % innerWidth;
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= innerWidth || ny < 0 || ny >= height) continue;
        const next = ny * innerWidth + nx;
        if (mask[next] === 0 && !visited[next]) { visited[next] = 1; component[size++] = next; }
      }
    }
    if (maxY - minY > height * 0.25) for (let i = 0; i < size; i++) mask[component[i]] = 255;
  }
  for (let y = 0; y < height; y++) {
    let ink = 0;
    for (let x = 0; x < innerWidth; x++) {
      const i = y * innerWidth + x;
      const contrast = background[i] - raw[i];
      if (mask[i] === 0 && contrast > 25) ink++;
    }
    if (ink / innerWidth <= 0.012) continue;
    const previous = bands.at(-1);
    if (previous && y - previous.to < height * 0.009) previous.to = y;
    else bands.push({ from: y, to: y });
  }
  const binary = await sharp(mask, { raw: { width: innerWidth, height, channels: 1 } }).png().toBuffer();
  return { binary, left, width: innerWidth, bands: bands
    .filter(band => band.to - band.from > height * 0.012 && band.to - band.from < height * 0.2)
    .sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, 10)
    .sort((a, b) => a.from - b.from) };
}
