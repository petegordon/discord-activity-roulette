/** "Back to the table" returns to wherever we came from, keeping that page's room (and a remote's key). */
export function backLinks() {
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href="/"]')) {
    a.addEventListener("click", (e) => {
      if (document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1) {
        e.preventDefault();
        history.back();
      }
    });
  }
}
