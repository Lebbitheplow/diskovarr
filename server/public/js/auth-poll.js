(function () {
  const statusEl = document.getElementById('poll-status');
  const subEl = document.getElementById('poll-sub');
  const retryEl = document.getElementById('poll-retry');

  let attempts = 0;
  const MAX_ATTEMPTS = 90; // 3 minutes at 2s intervals

  function poll() {
    if (attempts >= MAX_ATTEMPTS) {
      statusEl.textContent = 'Authorization timed out';
      subEl.textContent = 'The Plex sign-in window may have been closed.';
      retryEl.style.display = 'block';
      return;
    }

    fetch('/auth/check-pin')
      .then(r => r.json())
      .then(data => {
        attempts++;
        if (data.status === 'authorized') {
          statusEl.textContent = 'Authorized!';
          subEl.textContent = 'Redirecting...';
          window.location.href = data.landingUrl || '/?welcome=1';
        } else if (data.status === 'no_access') {
          statusEl.textContent = 'Access denied';
          subEl.textContent = "Your Plex account doesn't have access to this server.";
          retryEl.style.display = 'block';
        } else if (data.status === 'expired' || data.status === 'error') {
          statusEl.textContent = 'Something went wrong';
          subEl.textContent = data.message || 'Please try again.';
          retryEl.style.display = 'block';
        } else {
          // pending — keep polling
          setTimeout(poll, 2000);
        }
      })
      .catch(() => {
        attempts++;
        setTimeout(poll, 3000);
      });
  }

  // Start polling after a short delay
  setTimeout(poll, 1000);
})();
