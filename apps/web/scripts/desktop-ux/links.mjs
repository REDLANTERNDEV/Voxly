// Only protocol navigation is replaced; no real app or account is opened.
export const desktopOpenLink = (_origin, desktop = false) => (desktop ? null : "#");
export const desktopLaunchFromSearch = () => undefined;
export const desktopLaunchId = () => false;
