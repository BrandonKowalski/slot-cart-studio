const KEY = 'notice:on-device-studio';

export function noticeShown(storage) {
  try {
    return storage?.getItem(KEY) !== 'dismissed';
  } catch {
    return true;
  }
}

export function dismissNotice(storage) {
  try {
    storage?.setItem(KEY, 'dismissed');
  } catch {}
}
