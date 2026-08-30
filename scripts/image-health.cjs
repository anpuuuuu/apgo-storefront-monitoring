function classifyVisibleImages(images, explicitFailures = new Map()) {
  if (!images.length) return { state: 'waiting', detail: 'no-visible-image' };

  const missingSource = images.find((image) => !image.src);
  if (missingSource) return { state: 'failed', detail: 'visible-image-has-no-source' };

  const broken = images.find((image) => image.complete && image.width === 0);
  if (broken) return { state: 'failed', detail: `broken:${broken.src}` };

  const networkFailure = images.find((image) => explicitFailures.has(image.src));
  if (networkFailure) {
    return {
      state: 'failed',
      detail: `network:${networkFailure.src}:${explicitFailures.get(networkFailure.src)}`,
    };
  }

  const loading = images.find((image) => !image.complete);
  if (loading) return { state: 'loading', detail: loading.src };
  return { state: 'loaded', detail: '' };
}

module.exports = { classifyVisibleImages };
