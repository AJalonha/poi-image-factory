const form = document.querySelector('#job-form');
const submit = document.querySelector('#submit');
const statusBox = document.querySelector('#status');
const resultsBox = document.querySelector('#results');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = document.querySelector('#csv').files[0];
  if (!file) return;
  submit.disabled = true;
  resultsBox.innerHTML = '';
  statusBox.hidden = false;
  statusBox.textContent = 'Searching, evaluating, and generating images. This may take a few minutes for 10 properties.';

  const data = new FormData();
  data.append('csv', file);
  try {
    const response = await fetch('/api/process', { method: 'POST', body: data });
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error(raw || 'The server returned an invalid response.'); }
    if (!response.ok) throw new Error(payload.error || 'Processing failed.');

    let job;
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const statusResponse = await fetch(payload.statusUrl);
      const statusRaw = await statusResponse.text();
      try { job = JSON.parse(statusRaw); } catch { throw new Error(statusRaw || 'The status endpoint returned an invalid response.'); }
      if (!statusResponse.ok) throw new Error(job.error || 'Could not read processing status.');
      statusBox.textContent = `Processing ${job.completed} of ${job.total} properties…`;
      if (job.status === 'completed' || job.status === 'failed') break;
    }
    if (job.status === 'failed') throw new Error(job.error || 'Processing failed.');
    statusBox.innerHTML = job.zipUrl ? `<strong>Finished.</strong> <a href="${job.zipUrl}" download>Download ZIP</a>` : '<strong>Finished with no ZIP.</strong>';
    resultsBox.innerHTML = job.results.map((result) => {
      if (result.error) return `<article class="result error"><h2>${escapeHtml(result.property_name)}</h2><p>${escapeHtml(result.error)}</p></article>`;
      const check = result.inspection || {};
      return `<article class="result">
        <div class="result-head"><div><h2>${escapeHtml(result.property_name)}</h2><p>${escapeHtml([result.city, result.country].filter(Boolean).join(', '))}</p></div><span class="badge">${escapeHtml(result.mode.replaceAll('_', ' '))}</span></div>
        <div class="images"><figure><img src="${result.master_image_url}" alt="${escapeHtml(result.property_name)}"><figcaption>Master 1600 × 800</figcaption></figure></div>
        <p class="reason"><strong>Verification:</strong> ${escapeHtml(check.reason || 'Completed')} ${check.score ? `(${escapeHtml(check.score)}/100)` : ''}</p>
        ${result.source_url ? `<p class="source"><a href="${result.source_url}" target="_blank" rel="noreferrer">View source image</a></p>` : '<p class="source">No trustworthy source image was found; output was generated without a reference.</p>'}
      </article>`;
    }).join('');
  } catch (error) {
    statusBox.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
