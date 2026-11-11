const video = document.querySelector('#promo-video');
const fallback = document.querySelector('#video-error');
video.addEventListener('error', () => { fallback.hidden = false; });
video.querySelector('source').addEventListener('error', () => { fallback.hidden = false; });
document.querySelectorAll('a[href="#video"]').forEach(link => link.addEventListener('click', () => {
  video.play().catch(() => { /* Native controls remain available if autoplay is blocked. */ });
}));
