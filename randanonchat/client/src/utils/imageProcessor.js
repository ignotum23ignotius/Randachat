import { encryptImage, encryptImageForGroup } from './encryption';

// ── Constants ───────────────────────────────────────────────

const MAX_INPUT_SIZE = 40 * 1024 * 1024; // 40MB

export const ASPECT_RATIOS = [
  { label: '9:16',  value: 9 / 16 },
  { label: '4:5',   value: 4 / 5 },
  { label: '1:1',   value: 1 },
  { label: '3:2',   value: 3 / 2 },
  { label: '16:9',  value: 16 / 9 },
  { label: '4:3',   value: 4 / 3 },
  { label: 'Free',  value: null }
];

export const FILTERS = {
  none:           { label: 'None',            apply: (ctx, w, h) => {} },
  sepia:          { label: 'Sépia',           apply: applySepia },
  skinSmoothing:  { label: 'Skin Smoothing',  apply: applySkinSmoothing },
  eyeEnhancement: { label: 'Eye Enhancement', apply: applyEyeEnhancement },
  bw:             { label: 'B&W',             apply: applyBW },
  contrast:       { label: 'Contrast',        apply: applyContrast },
  warmth:         { label: 'Warmth',          apply: applyWarmth }
};

export const TEXT_FONTS = [
  'Playfair Display',
  'Montserrat',
  'Pacifico'
];

// ── 1. Load & validate ──────────────────────────────────────

export async function loadImage(file) {
  if (file.size > MAX_INPUT_SIZE) {
    throw new Error(`Image exceeds maximum size of ${MAX_INPUT_SIZE / 1024 / 1024}MB`);
  }

  const bitmap = await createImageBitmap(file);
  return bitmap;
}

// ── 2. EXIF stripping ───────────────────────────────────────
// Re-draw through canvas to discard ALL EXIF metadata
// (GPS, device info, timestamps — everything).
// This MUST run before any other processing step.

export function stripExif(bitmap) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  return { canvas, ctx, width: bitmap.width, height: bitmap.height };
}

// ── 3. Crop system ──────────────────────────────────────────

// Calculate initial crop box centered on the image for a given aspect ratio.
export function calculateCropBox(imageWidth, imageHeight, aspectRatio) {
  // Free crop — full image
  if (aspectRatio === null) {
    return { x: 0, y: 0, width: imageWidth, height: imageHeight };
  }

  let cropWidth, cropHeight;

  if (imageWidth / imageHeight > aspectRatio) {
    // Image is wider than ratio — constrain by height
    cropHeight = imageHeight;
    cropWidth = Math.round(cropHeight * aspectRatio);
  } else {
    // Image is taller than ratio — constrain by width
    cropWidth = imageWidth;
    cropHeight = Math.round(cropWidth / aspectRatio);
  }

  const x = Math.round((imageWidth - cropWidth) / 2);
  const y = Math.round((imageHeight - cropHeight) / 2);

  return { x, y, width: cropWidth, height: cropHeight };
}

// Corner drag: scale crop window up/down while maintaining aspect ratio.
// scaleFactor > 1 = grow, < 1 = shrink. Crop box stays centered.
export function resizeCropBox(cropBox, scaleFactor, imageWidth, imageHeight, aspectRatio) {
  let newWidth = Math.round(cropBox.width * scaleFactor);
  let newHeight;

  if (aspectRatio === null) {
    newHeight = Math.round(cropBox.height * scaleFactor);
  } else {
    newHeight = Math.round(newWidth / aspectRatio);
  }

  // Clamp to image bounds
  newWidth = Math.min(newWidth, imageWidth);
  newHeight = Math.min(newHeight, imageHeight);

  // Re-enforce ratio after clamping
  if (aspectRatio !== null) {
    if (newWidth / newHeight > aspectRatio) {
      newWidth = Math.round(newHeight * aspectRatio);
    } else {
      newHeight = Math.round(newWidth / aspectRatio);
    }
  }

  // Re-center
  const centerX = cropBox.x + cropBox.width / 2;
  const centerY = cropBox.y + cropBox.height / 2;
  let x = Math.round(centerX - newWidth / 2);
  let y = Math.round(centerY - newHeight / 2);

  // Clamp position so crop NEVER escapes image bounds
  x = Math.max(0, Math.min(x, imageWidth - newWidth));
  y = Math.max(0, Math.min(y, imageHeight - newHeight));

  return { x, y, width: newWidth, height: newHeight };
}

// Center drag: move crop box within image, NEVER escape image bounds.
export function moveCropBox(cropBox, deltaX, deltaY, imageWidth, imageHeight) {
  let x = cropBox.x + deltaX;
  let y = cropBox.y + deltaY;

  x = Math.max(0, Math.min(x, imageWidth - cropBox.width));
  y = Math.max(0, Math.min(y, imageHeight - cropBox.height));

  return { ...cropBox, x, y };
}

// Apply crop: extract the crop region to a new canvas.
export function applyCrop(sourceCanvas, cropBox) {
  const canvas = document.createElement('canvas');
  canvas.width = cropBox.width;
  canvas.height = cropBox.height;
  const ctx = canvas.getContext('2d');

  ctx.drawImage(
    sourceCanvas,
    cropBox.x, cropBox.y, cropBox.width, cropBox.height,
    0, 0, cropBox.width, cropBox.height
  );

  return { canvas, ctx, width: cropBox.width, height: cropBox.height };
}

// ── 4. Filters ──────────────────────────────────────────────
// All filters operate on pixel data via Canvas API (client-side).

function getPixels(ctx, w, h) {
  return ctx.getImageData(0, 0, w, h);
}

function putPixels(ctx, imageData) {
  ctx.putImageData(imageData, 0, 0);
}

function applySepia(ctx, w, h) {
  const imageData = getPixels(ctx, w, h);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    d[i]     = Math.min(255, r * 0.393 + g * 0.769 + b * 0.189);
    d[i + 1] = Math.min(255, r * 0.349 + g * 0.686 + b * 0.168);
    d[i + 2] = Math.min(255, r * 0.272 + g * 0.534 + b * 0.131);
  }
  putPixels(ctx, imageData);
}

function applySkinSmoothing(ctx, w, h) {
  // Gaussian-like blur via multiple box blurs for skin smoothing.
  // CanvasRenderingContext2D.filter is widely supported.
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = w;
  tempCanvas.height = h;
  const tempCtx = tempCanvas.getContext('2d');

  // Draw blurred version
  tempCtx.filter = 'blur(3px)';
  tempCtx.drawImage(ctx.canvas, 0, 0);

  // Blend blurred back at reduced opacity for a natural look
  ctx.globalAlpha = 0.5;
  ctx.drawImage(tempCanvas, 0, 0);
  ctx.globalAlpha = 1.0;
}

function applyEyeEnhancement(ctx, w, h) {
  // Sharpen + increase saturation for eye pop effect
  const imageData = getPixels(ctx, w, h);
  const d = imageData.data;

  // Increase saturation
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    const saturation = 1.4;
    d[i]     = Math.min(255, Math.max(0, gray + saturation * (r - gray)));
    d[i + 1] = Math.min(255, Math.max(0, gray + saturation * (g - gray)));
    d[i + 2] = Math.min(255, Math.max(0, gray + saturation * (b - gray)));
  }

  putPixels(ctx, imageData);

  // Sharpen via unsharp mask: overlay sharpened copy
  const sharpCanvas = document.createElement('canvas');
  sharpCanvas.width = w;
  sharpCanvas.height = h;
  const sharpCtx = sharpCanvas.getContext('2d');
  sharpCtx.filter = 'contrast(1.2) brightness(1.05)';
  sharpCtx.drawImage(ctx.canvas, 0, 0);

  ctx.globalAlpha = 0.3;
  ctx.drawImage(sharpCanvas, 0, 0);
  ctx.globalAlpha = 1.0;
}

function applyBW(ctx, w, h) {
  const imageData = getPixels(ctx, w, h);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = gray;
  }
  putPixels(ctx, imageData);
}

function applyContrast(ctx, w, h) {
  const imageData = getPixels(ctx, w, h);
  const d = imageData.data;
  const factor = 1.5;
  const intercept = 128 * (1 - factor);
  for (let i = 0; i < d.length; i += 4) {
    d[i]     = Math.min(255, Math.max(0, d[i] * factor + intercept));
    d[i + 1] = Math.min(255, Math.max(0, d[i + 1] * factor + intercept));
    d[i + 2] = Math.min(255, Math.max(0, d[i + 2] * factor + intercept));
  }
  putPixels(ctx, imageData);
}

function applyWarmth(ctx, w, h) {
  const imageData = getPixels(ctx, w, h);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i]     = Math.min(255, d[i] + 15);      // boost red
    d[i + 1] = Math.min(255, d[i + 1] + 5);   // slight green
    d[i + 2] = Math.max(0, d[i + 2] - 10);    // reduce blue
  }
  putPixels(ctx, imageData);
}

export function applyFilter(canvas, ctx, filterName) {
  const filter = FILTERS[filterName];
  if (!filter) throw new Error(`Unknown filter: ${filterName}`);
  const w = canvas.width;
  const h = canvas.height;
  filter.apply(ctx, w, h);
  return { canvas, ctx, width: w, height: h };
}

// ── 5. Text overlay ─────────────────────────────────────────

export function applyTextOverlay(canvas, ctx, options) {
  const {
    text,
    font = TEXT_FONTS[0],
    size = 32,
    x,
    y,
    color = '#ffffff',
    glow = false,
    glowColor = '#ff0000'
  } = options;

  ctx.save();

  ctx.font = `${size}px '${font}', sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;

  if (glow) {
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = size * 0.4;
    // Draw multiple times for stronger glow
    ctx.fillText(text, x, y);
    ctx.fillText(text, x, y);
  }

  ctx.fillText(text, x, y);
  ctx.restore();

  return { canvas, ctx, width: canvas.width, height: canvas.height };
}

// ── 6. Watermark (group leak prevention) ────────────────────

export function applyWatermark(canvas, ctx, groupName, username) {
  const w = canvas.width;
  const h = canvas.height;

  ctx.save();

  const watermarkText = `${groupName} • ${username}`;
  const fontSize = Math.max(14, Math.round(w * 0.03));

  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.textBaseline = 'middle';

  const textWidth = ctx.measureText(watermarkText).width;
  const stepX = textWidth + 80;
  const stepY = fontSize * 4;

  // Tile the watermark across the entire image
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-0.3);

  for (let dy = -h; dy < h * 2; dy += stepY) {
    for (let dx = -w; dx < w * 2; dx += stepX) {
      ctx.fillText(watermarkText, dx - w / 2, dy - h / 2);
    }
  }

  ctx.restore();

  return { canvas, ctx, width: w, height: h };
}

// ── 7. Export canvas to buffer ───────────────────────────────

export function canvasToBuffer(canvas, mimeType = 'image/png', quality = 0.92) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      blob.arrayBuffer().then(resolve);
    }, mimeType, quality);
  });
}

// ── 8. Full pipeline ────────────────────────────────────────
// Pipeline order from spec:
//   Select → CSAM check → EXIF strip → Crop → Filter → Text → Encrypt → Upload
//
// CSAM check is handled externally before calling this function.
// Upload is handled by the caller after receiving the encrypted result.

export async function processAndEncrypt(file, options = {}) {
  const {
    cropBox = null,
    filterName = 'none',
    textOverlay = null,
    recipientPublicKey = null,
    groupMemberPublicKeys = null,
    watermark = null
  } = options;

  // 1. Load & validate size
  const bitmap = await loadImage(file);

  // 2. Strip EXIF — always first
  let { canvas, ctx } = stripExif(bitmap);

  // 3. Crop
  if (cropBox) {
    ({ canvas, ctx } = applyCrop(canvas, cropBox));
  }

  // 4. Filter
  if (filterName && filterName !== 'none') {
    applyFilter(canvas, ctx, filterName);
  }

  // 5. Text overlay
  if (textOverlay && textOverlay.text) {
    applyTextOverlay(canvas, ctx, textOverlay);
  }

  // 6. Watermark (group images only)
  if (watermark) {
    applyWatermark(canvas, ctx, watermark.groupName, watermark.username);
  }

  // 7. Export to buffer
  const buffer = await canvasToBuffer(canvas);

  // 8. Encrypt with recipient's public key (hybrid encryption)
  if (groupMemberPublicKeys && groupMemberPublicKeys.length > 0) {
    return encryptImageForGroup(buffer, groupMemberPublicKeys);
  }

  if (recipientPublicKey) {
    return encryptImage(buffer, recipientPublicKey);
  }

  throw new Error('Either recipientPublicKey or groupMemberPublicKeys is required');
}
