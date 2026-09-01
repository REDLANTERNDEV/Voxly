/**
 * Copy to the clipboard, including where the modern way is not available.
 *
 * `navigator.clipboard` only exists in a secure context. A self-hosted Voxly
 * reached over a local network by address — `http://192.168.0.107:5173`, which
 * is exactly how somebody links their phone before they have a certificate — is
 * not one, so the property is simply missing and the button did nothing at all.
 *
 * The fallback is the old selection trick. It is deprecated and it is also the
 * only thing that works there, which is the whole argument for keeping it.
 */
export async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission refused, or a browser that has the property but not the
    // permission. Fall through rather than giving up.
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    // Off-screen rather than hidden: a `display: none` element cannot be
    // selected, and moving focus must not scroll the page under the member.
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}
