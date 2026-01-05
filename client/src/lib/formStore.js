// src/lib/formStore.js
const _store = { payload: null, files: {} };

export function setAdmissionDraft({ payload, files }) {
  _store.payload = payload;
  _store.files = files || {};
}

export function getAdmissionDraft() {
  return { payload: _store.payload, files: _store.files };
}

export function clearAdmissionDraft() {
  _store.payload = null;
  _store.files = {};
}
