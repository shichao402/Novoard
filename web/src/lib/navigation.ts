function changeLocation(path: string, replace: boolean) {
  if (replace) {
    window.history.replaceState(null, "", path);
  } else {
    window.history.pushState(null, "", path);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export const history = {
  push(path: string) {
    changeLocation(path, false);
  },
  replace(path: string) {
    changeLocation(path, true);
  },
};
