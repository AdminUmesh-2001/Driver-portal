import React, { useEffect, useMemo, useRef, useState } from 'react';
import Tesseract from 'tesseract.js';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import './App.css';

const STORAGE_KEY = 'astar-move-tracking-state-v4';
const MAX_SCREENSHOTS = 30;
const EMAIL_BACKEND_URL =
  process.env.REACT_APP_BACKEND_URL ||
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? `${window.location.protocol}//${window.location.hostname}:4000`
    : 'https://nexora-driver-backend.onrender.com');
const LOGIN_FACE_PARAM = new URLSearchParams(window.location.search).get('face');
const DEFAULT_LOGIN_FACE = window.location.port === '3001' ? 'admin' : 'driver';
const DEFAULT_ADMIN_ACCOUNT = {
  id: 'admin-umesh',
  role: 'admin',
  name: 'UMESH',
  email: 'umesh@local',
  username: 'umesh',
  password: 'umesh123',
};

const starterMoves = [];

function getTimestampParts() {
  const now = new Date();
  return {
    display: now.toLocaleString(),
    sortValue: now.getTime(),
    dateOnly: now.toISOString().slice(0, 10),
  };
}

function createEmptyForm(defaultDriver = '') {
  const timestamp = getTimestampParts();
  return {
    driverName: defaultDriver,
    entryDate: timestamp.dateOnly,
    screenshots: [],
  };
}

function createEmptyFuelForm(defaultDriver = '') {
  return {
    driverName: defaultDriver,
    entryDate: getTimestampParts().dateOnly,
    km: '',
    fuelQuantity: '',
    fuelCost: '',
    station: '',
    notes: '',
    receipt: null,
  };
}

function createEmptyExpenseForm(defaultDriver = '') {
  return {
    driverName: defaultDriver,
    entryDate: getTimestampParts().dateOnly,
    category: 'Truck Receipt',
    vendor: '',
    total: '',
    notes: '',
    receipt: null,
  };
}

function createEmptyPaycheckForm(defaultDriver = '') {
  return {
    driverName: defaultDriver,
    startDate: getTimestampParts().dateOnly,
    endDate: getTimestampParts().dateOnly,
    paycheckAmount: '',
    notes: '',
  };
}

function normalizeName(value) {
  return toUpperWords(value).trim();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function generatePassword() {
  return Math.random().toString(36).slice(-10).toUpperCase();
}

async function sendDriverRegistrationEmail(payload) {
  const response = await fetch(`${EMAIL_BACKEND_URL}/api/email/register-driver`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json().catch(() => ({
    ok: false,
    message: 'The email backend returned an invalid response.',
  }));

  if (!response.ok || !result.ok) {
    throw new Error(result.message || 'Registration email failed.');
  }

  return result;
}

async function saveSharedAccounts(accounts) {
  const response = await fetch(`${EMAIL_BACKEND_URL}/api/accounts`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ accounts }),
  });

  const result = await response.json().catch(() => ({
    ok: false,
    message: 'The accounts backend returned an invalid response.',
  }));

  if (!response.ok || !result.ok || !Array.isArray(result.accounts)) {
    throw new Error(result.message || 'Could not save shared driver accounts.');
  }

  return result.accounts;
}

async function fetchSharedState() {
  const response = await fetch(`${EMAIL_BACKEND_URL}/api/shared-state`);
  const result = await response.json().catch(() => ({
    ok: false,
    message: 'The shared backend returned an invalid response.',
  }));

  if (!response.ok || !result.ok || !result.state || typeof result.state !== 'object') {
    throw new Error(result.message || 'Could not load shared app data.');
  }

  return result.state;
}

async function fetchBackendHealth() {
  const response = await fetch(`${EMAIL_BACKEND_URL}/api/health`);
  const result = await response.json().catch(() => ({
    ok: false,
    message: 'The backend health check returned an invalid response.',
  }));

  if (!response.ok || !result.ok) {
    throw new Error(result.message || 'Could not connect to the shared backend.');
  }

  return result;
}

async function saveSharedState(state) {
  const response = await fetch(`${EMAIL_BACKEND_URL}/api/shared-state`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ state }),
  });

  const result = await response.json().catch(() => ({
    ok: false,
    message: 'The shared backend returned an invalid response.',
  }));

  if (!response.ok || !result.ok || !result.state || typeof result.state !== 'object') {
    throw new Error(result.message || 'Could not save shared app data.');
  }

  return result.state;
}

function mergeAccounts(localAccounts, remoteAccounts) {
  const mergedMap = new Map();
  const addOrUpdate = (account) => {
    if (!account?.id) {
      return;
    }

    const existing = mergedMap.get(account.id);
    if (!existing) {
      mergedMap.set(account.id, account);
      return;
    }

    const existingSort = existing.accountUpdatedAtSort || 0;
    const accountSort = account.accountUpdatedAtSort || 0;
    mergedMap.set(account.id, accountSort >= existingSort ? account : existing);
  };

  (remoteAccounts || []).forEach(addOrUpdate);
  (localAccounts || []).forEach(addOrUpdate);

  const merged = Array.from(mergedMap.values());
  const admin = merged.find((account) => account.role === 'admin') || DEFAULT_ADMIN_ACCOUNT;
  const drivers = merged.filter((account) => account.id !== admin.id);
  return [admin, ...drivers];
}

function mergeRecordsById(localItems = [], remoteItems = []) {
  const mergedMap = new Map();

  (remoteItems || []).forEach((item) => {
    if (item?.id) {
      mergedMap.set(item.id, item);
    }
  });

  (localItems || []).forEach((item) => {
    if (!item?.id) {
      return;
    }

    const existing = mergedMap.get(item.id);
    if (!existing) {
      mergedMap.set(item.id, item);
      return;
    }

    const existingSort = existing.updatedAtSort || existing.recordedAtSort || existing.createdAtSort || 0;
    const itemSort = item.updatedAtSort || item.recordedAtSort || item.createdAtSort || 0;
    mergedMap.set(item.id, itemSort >= existingSort ? item : existing);
  });

  return Array.from(mergedMap.values());
}

function mergeRecycleItems(localItems = [], remoteItems = []) {
  return mergeRecordsById(localItems, remoteItems).sort(
    (a, b) => (b.deletedAtSort || 0) - (a.deletedAtSort || 0)
  );
}

function mergeStringLists(localItems = [], remoteItems = []) {
  return Array.from(new Set([...(remoteItems || []), ...(localItems || [])].filter(Boolean)));
}

function createDeletedItem(type, item) {
  const timestamp = getTimestampParts();
  const sourceId = item.id || item.previewUrl || '';
  return {
    id: `trash-${type}-${sourceId || timestamp.sortValue}-${timestamp.sortValue}`,
    sourceId,
    type,
    name: item.name || item.moveNumber || item.fileName || 'Deleted item',
    driverName: item.driverName || '',
    previewUrl: item.previewUrl || item.screenshots?.[0]?.previewUrl || '',
    payload: item,
    deletedAt: timestamp.display,
    deletedAtSort: timestamp.sortValue,
  };
}

function sortFilesNewestFirst(items = []) {
  return [...items].sort((a, b) => (b.updatedAtSort || 0) - (a.updatedAtSort || 0));
}

function getShotSignature(shot) {
  if (!shot) {
    return '';
  }

  return [shot.previewUrl || '', shot.name || '', shot.size || ''].join('|');
}

function getMoveRecordQuality(move) {
  const screenshot = move?.screenshots?.[0];
  const screenshotOcrDone = screenshot?.ocrStatus === 'done' ? 1 : 0;
  const hasStructuredMoveNumber =
    move?.moveNumber && !String(move.moveNumber).startsWith('PENDING-') && !/WHATSAPP IMAGE/i.test(String(move.moveNumber))
      ? 1
      : 0;
  const hasUsefulOrigin = move?.origin && !/WHATSAPP IMAGE/i.test(String(move.origin)) ? 1 : 0;
  const hasUsefulDestination = move?.destination && String(move.destination) !== '-' ? 1 : 0;
  const hasUsefulContainer = move?.containerNumber && String(move.containerNumber) !== '-' ? 1 : 0;

  return (
    screenshotOcrDone * 100 +
    hasStructuredMoveNumber * 40 +
    hasUsefulOrigin * 20 +
    hasUsefulDestination * 10 +
    hasUsefulContainer * 10 +
    (move?.recordedAtSort || 0) / 10000000000000
  );
}

function dedupeMoveRecords(rows = []) {
  const bestBySignature = new Map();

  rows.forEach((move) => {
    const signature = getShotSignature(move?.screenshots?.[0]);
    if (!signature) {
      return;
    }

    const currentBest = bestBySignature.get(signature);
    if (!currentBest || getMoveRecordQuality(move) >= getMoveRecordQuality(currentBest)) {
      bestBySignature.set(signature, move);
    }
  });

  return Array.from(bestBySignature.values());
}

function buildUpdatedAccounts(accounts, accountId, updater) {
  return accounts.map((account) => (account.id === accountId ? updater(account) : account));
}

function fileToPreview(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        name: file.name,
        type: file.type,
        size: file.size,
        previewUrl: String(reader.result),
      });
    };
    reader.readAsDataURL(file);
  });
}

function toUpperWords(value) {
  return String(value || '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function cleanCandidate(value) {
  return toUpperWords(value).replace(/[^A-Z0-9\s-]/g, '').trim();
}

function pickLocationFromLine(line) {
  const cleaned = cleanCandidate(line);
  if (!cleaned) {
    return '';
  }

  const pieces = cleaned
    .split(/[\s,/-]+/)
    .filter(
      (part) =>
        /^[A-Z]{3,}$/.test(part) &&
        !['MOVE', 'NUMBER', 'CONTAINER', 'MILES', 'ORIGIN', 'DESTINATION', 'FROM', 'TO'].includes(
          part
        )
    );

  return pieces.slice(0, 3).join(' ');
}

function parseLabeledValue(text, labels) {
  for (const label of labels) {
    const matcher = new RegExp(`${label}\\s*[:#-]?\\s*([A-Z0-9 -]{2,})`, 'i');
    const match = text.match(matcher);
    if (match?.[1]) {
      return cleanCandidate(match[1]);
    }
  }

  return '';
}

function parseLineValue(lines, labels, preservePunctuation = false) {
  const labelPattern = labels.join('|');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(new RegExp(`(?:${labelPattern})\\s*[:#-]?\\s*(.+)$`, 'i'));
    if (match?.[1]) {
      const value = match[1].trim();
      return preservePunctuation
        ? value.replace(/\s+/g, ' ').trim()
        : cleanCandidate(value);
    }

    if (new RegExp(`^(?:${labelPattern})$`, 'i').test(line) && lines[index + 1]) {
      return preservePunctuation
        ? lines[index + 1].replace(/\s+/g, ' ').trim()
        : cleanCandidate(lines[index + 1]);
    }
  }

  return '';
}

function normalizeDateTimeText(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[|,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDateTimeValue(value, referenceDate = null) {
  const normalized = normalizeDateTimeText(value);
  if (!normalized) {
    return null;
  }

  const directCandidate = normalized.replace(/\bAT\b/g, ' ');
  const directDate = new Date(directCandidate);
  if (!Number.isNaN(directDate.getTime())) {
    return directDate;
  }

  const dateTimeMatch = normalized.match(
    /(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\s+(\d{1,2}):(\d{2})(?:\s*([AP]M))?/
  );
  if (dateTimeMatch) {
    let [, month, day, year, hours, minutes, meridiem] = dateTimeMatch;
    let hour = Number(hours);
    if (meridiem === 'PM' && hour < 12) {
      hour += 12;
    }
    if (meridiem === 'AM' && hour === 12) {
      hour = 0;
    }
    const fullYear = Number(year.length === 2 ? `20${year}` : year);
    const parsed = new Date(fullYear, Number(month) - 1, Number(day), hour, Number(minutes));
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const timeOnlyMatch = normalized.match(/\b(\d{1,2}):(\d{2})(?:\s*([AP]M))?\b/);
  if (timeOnlyMatch && referenceDate) {
    let [, hours, minutes, meridiem] = timeOnlyMatch;
    let hour = Number(hours);
    if (meridiem === 'PM' && hour < 12) {
      hour += 12;
    }
    if (meridiem === 'AM' && hour === 12) {
      hour = 0;
    }
    const parsed = new Date(referenceDate);
    parsed.setHours(hour, Number(minutes), 0, 0);
    return parsed;
  }

  return null;
}

function formatDateTimeDisplay(dateTime, fallbackText = '-') {
  if (dateTime && !Number.isNaN(dateTime.getTime())) {
    return dateTime.toLocaleString();
  }

  return normalizeDateTimeText(fallbackText) || '-';
}

function formatMilitaryDateTime(dateTime, fallbackText = '-') {
  if (dateTime && !Number.isNaN(dateTime.getTime())) {
    const year = dateTime.getFullYear();
    const month = String(dateTime.getMonth() + 1).padStart(2, '0');
    const day = String(dateTime.getDate()).padStart(2, '0');
    const hours = String(dateTime.getHours()).padStart(2, '0');
    const minutes = String(dateTime.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  return normalizeDateTimeText(fallbackText) || '-';
}

function dateInputToSort(value) {
  const parsed = new Date(`${value || getTimestampParts().dateOnly}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();
}

function sortByXatDateTime(items = [], accessor = (item) => item) {
  return [...items].sort((left, right) => {
    const leftValue = accessor(left);
    const rightValue = accessor(right);
    const leftSort =
      leftValue?.xatDateTimeSort ??
      leftValue?.recordedAtSort ??
      leftValue?.updatedAtSort ??
      leftValue?.deletedAtSort ??
      0;
    const rightSort =
      rightValue?.xatDateTimeSort ??
      rightValue?.recordedAtSort ??
      rightValue?.updatedAtSort ??
      rightValue?.deletedAtSort ??
      0;

    if (leftSort !== rightSort) {
      return leftSort - rightSort;
    }

    return String(leftValue?.moveNumber || leftValue?.name || '').localeCompare(
      String(rightValue?.moveNumber || rightValue?.name || '')
    );
  });
}

function formatWaitTime(minutes) {
  if (minutes == null || Number.isNaN(minutes)) {
    return '-';
  }

  const safeMinutes = Math.max(0, minutes);
  const hoursPart = Math.floor(safeMinutes / 60);
  const minutesPart = safeMinutes % 60;
  return `${hoursPart}h ${minutesPart}m`;
}

function calculateWaitTime({ xatDateTime, arrivalDateTime, releaseDateTime }) {
  if (!releaseDateTime || (!xatDateTime && !arrivalDateTime)) {
    return { waitMinutes: null, waitTime: '-' };
  }

  const baseTime =
    xatDateTime && arrivalDateTime
      ? arrivalDateTime > xatDateTime
        ? arrivalDateTime
        : xatDateTime
      : arrivalDateTime || xatDateTime;

  if (!baseTime) {
    return { waitMinutes: null, waitTime: '-' };
  }

  const waitStart = new Date(baseTime.getTime() + 60 * 60 * 1000);
  const waitMinutes = Math.max(0, Math.round((releaseDateTime.getTime() - waitStart.getTime()) / 60000));

  return {
    waitMinutes,
    waitTime: formatWaitTime(waitMinutes),
  };
}

function deriveFieldsFromText(rawText, fileName = '') {
  const safeFileName = /^whatsapp image/i.test(String(fileName || '').trim())
    ? ''
    : String(fileName || '').replace(/\.[^.]+$/, '');
  const mergedText = `${rawText || ''}\n${safeFileName}`;
  const upperText = toUpperWords(mergedText);
  const lines = upperText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const compactText = lines.join(' ');

  const moveNumber =
    parseLabeledValue(compactText, ['MOVE\\s*#?', 'MOVE\\s*NUMBER', 'MOVE\\s*NO']) ||
    compactText.match(/\b\d{6,}(?:-\d+)?\b/)?.[0] ||
    '';

  const containerNumber =
    parseLabeledValue(compactText, ['CONTAINER\\s*#?', 'CONTAINER\\s*NUMBER', 'CNTR']) ||
    compactText.match(/\b(?:CONT[- ]?\d{3,}|[A-Z]{4}\d{6,})\b/)?.[0] ||
    '';

  const miles =
    parseLabeledValue(compactText, ['MILES?', 'MI'])?.match(/\d{1,4}(?:\.\d+)?/)?.[0] ||
    compactText.match(/\b\d{1,4}(?:\.\d+)?\s*(?:MILES|MI)\b/)?.[0]?.match(/\d{1,4}(?:\.\d+)?/)?.[0] ||
    '';

  let origin = parseLabeledValue(compactText, ['ORIGIN', 'FROM', 'PICKUP']);
  let destination = parseLabeledValue(compactText, ['DESTINATION', 'DEST', 'TO', 'DELIVERY']);

  if (!origin || !destination) {
    const fromIndex = lines.findIndex((line) => /\b(FROM|ORIGIN|PICKUP)\b/.test(line));
    const toIndex = lines.findIndex((line) => /\b(TO|DESTINATION|DEST|DELIVERY)\b/.test(line));

    if (!origin && fromIndex >= 0) {
      origin = pickLocationFromLine(lines[fromIndex + 1] || lines[fromIndex]);
    }

    if (!destination && toIndex >= 0) {
      destination = pickLocationFromLine(lines[toIndex + 1] || lines[toIndex]);
    }
  }

  if (!origin || !destination) {
    const locationLines = lines.map((line) => pickLocationFromLine(line)).filter(Boolean);
    if (!origin) {
      origin = locationLines[0] || '';
    }
    if (!destination) {
      destination = locationLines[1] || '';
    }
  }

  const xatRaw = parseLineValue(lines, ['XAT\\s*DATE\\s*TIME', 'XAT\\s*DATE', 'XAT'], true);
  const xatDateTime = parseDateTimeValue(xatRaw);

  return {
    moveNumber: cleanCandidate(moveNumber),
    containerNumber: cleanCandidate(containerNumber),
    miles: cleanCandidate(miles),
    origin: cleanCandidate(origin),
    destination: cleanCandidate(destination),
    xatDateTime: formatMilitaryDateTime(xatDateTime, xatRaw),
    xatDateTimeSort: xatDateTime?.getTime() || 0,
  };
}

function deriveFuelFieldsFromText(rawText, fileName = '') {
  const mergedText = `${rawText || ''}\n${fileName.replace(/\.[^.]+$/, '')}`;
  const upperText = toUpperWords(mergedText);
  const lines = upperText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const compactText = lines.join(' ');
  const dateMatch = compactText.match(/\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/);
  const kmMatch =
    parseLabeledValue(compactText, ['ODOMETER', 'KM', 'KMS', 'MILEAGE'])?.match(/\d{3,7}/)?.[0] ||
    compactText.match(/\b\d{3,7}\s*(?:KM|KMS)\b/)?.[0]?.match(/\d{3,7}/)?.[0] ||
    '';
  const quantityMatch =
    parseLabeledValue(compactText, ['LITRES?', 'LITERS?', 'L', 'QTY', 'QUANTITY'])?.match(/\d{1,4}(?:\.\d{1,3})?/)?.[0] ||
    compactText.match(/\b\d{1,4}(?:\.\d{1,3})?\s*(?:L|LITRE|LITER|GAL|GALLON)\b/)?.[0]?.match(/\d{1,4}(?:\.\d{1,3})?/)?.[0] ||
    '';
  const totalMatch =
    parseLabeledValue(compactText, ['TOTAL', 'AMOUNT', 'SALE'])?.match(/\d{1,5}(?:\.\d{2})/)?.[0] ||
    compactText.match(/\$\s*(\d{1,5}(?:\.\d{2}))/)?.[1] ||
    '';

  return {
    entryDate: dateMatch ? parseDateTimeValue(dateMatch[1])?.toISOString().slice(0, 10) || '' : '',
    km: kmMatch,
    fuelQuantity: quantityMatch,
    fuelCost: totalMatch,
    station: lines.find((line) => /(PETRO|ESSO|SHELL|HUSKY|PILOT|FLYING|CARDLOCK|FUEL)/.test(line)) || '',
  };
}

function deriveExpenseFieldsFromText(rawText, fileName = '') {
  const mergedText = `${rawText || ''}\n${fileName.replace(/\.[^.]+$/, '')}`;
  const upperText = toUpperWords(mergedText);
  const lines = upperText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const compactText = lines.join(' ');
  const total =
    parseLabeledValue(compactText, ['TOTAL', 'AMOUNT', 'BALANCE'])?.match(/\d{1,5}(?:\.\d{2})/)?.[0] ||
    compactText.match(/\$\s*(\d{1,5}(?:\.\d{2}))/)?.[1] ||
    '';
  const dateMatch = compactText.match(/\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/);

  return {
    entryDate: dateMatch ? parseDateTimeValue(dateMatch[1])?.toISOString().slice(0, 10) || '' : '',
    vendor: lines[0] || '',
    total,
  };
}

function deriveWaitFieldsFromText(rawText, fileName = '') {
  const baseFields = deriveFieldsFromText(rawText, fileName);
  const mergedText = `${rawText || ''}\n${fileName.replace(/\.[^.]+$/, '')}`;
  const upperText = toUpperWords(mergedText);
  const lines = upperText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const driverName =
    parseLineValue(lines, ['DRIVER\\s*NAME', 'DRIVER'], true) || '';
  const xatRaw = parseLineValue(lines, ['XAT\\s*DATE\\s*TIME', 'XAT\\s*DATE', 'XAT'], true);
  const arrivalRaw = parseLineValue(lines, ['ARRIVAL\\s*TIME', 'ARRIVED\\s*AT', 'ARRIVED', 'ARRIVAL'], true);
  const releaseRaw = parseLineValue(lines, ['RELEASE\\s*TIME', 'RELEASE'], true);
  const departRaw = parseLineValue(lines, ['DEPART\\s*TIME', 'DEPARTED\\s*AT', 'DEPARTED', 'DEPART'], true);

  const xatDateTime = parseDateTimeValue(xatRaw);
  const arrivalDateTime = parseDateTimeValue(arrivalRaw, xatDateTime);
  const releaseDateTime = parseDateTimeValue(releaseRaw, xatDateTime || arrivalDateTime);
  const departDateTime = parseDateTimeValue(departRaw, xatDateTime || arrivalDateTime || releaseDateTime);
  const waitInfo = calculateWaitTime({ xatDateTime, arrivalDateTime, releaseDateTime });

  return {
    ...baseFields,
    driverName: cleanCandidate(driverName),
    xatDateTime: formatDateTimeDisplay(xatDateTime, xatRaw),
    arrivalTime: formatDateTimeDisplay(arrivalDateTime, arrivalRaw),
    releaseTime: formatDateTimeDisplay(releaseDateTime, releaseRaw),
    departTime: formatDateTimeDisplay(departDateTime, departRaw),
    waitMinutes: waitInfo.waitMinutes,
    waitTime: waitInfo.waitTime,
  };
}

function normalizeMoveNumber(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9-]/g, '');
}

function pickCleanMoveNumber(...values) {
  const combined = values
    .map((value) => String(value || '').toUpperCase())
    .join(' ');
  const matches = combined.match(/\b\d{6,}(?:-\d+)?\b/g);
  return matches?.[0] || '';
}

function normalizeSharedStateShape(state = {}) {
  const purgedRecycleIds = state.purgedRecycleIds || [];
  const restoredRecycleIds = state.restoredRecycleIds || [];
  const clearedMoveIds = state.clearedMoveIds || [];
  const deletedSourceIdsState = state.deletedSourceIdsState || [];
  const deletedSourceIds = new Set(deletedSourceIdsState);
  const activeRecycleBin = (state.recycleBin || []).filter(
    (item) =>
      item?.id &&
      !purgedRecycleIds.includes(item.id) &&
      !restoredRecycleIds.includes(item.id)
  );

  activeRecycleBin.forEach((item) => {
    if (item.sourceId) {
      deletedSourceIds.add(item.sourceId);
    }
  });

  return {
    ...state,
    moves: sortByXatDateTime(
      dedupeMoveRecords(
        (state.moves || []).filter(
          (move) => (move.screenshots?.length || 0) > 0 && !clearedMoveIds.includes(move.id)
        )
      )
    ),
    waitRecords: sortByXatDateTime(
      (state.waitRecords || []).filter((record) => (record.screenshots?.length || 0) > 0)
    ),
    savedFiles: sortFilesNewestFirst(
      (state.savedFiles || []).filter((file) => !deletedSourceIds.has(file.id))
    ),
    waitSavedFiles: sortFilesNewestFirst(
      (state.waitSavedFiles || []).filter((file) => !deletedSourceIds.has(file.id))
    ),
    companyFiles: sortFilesNewestFirst(
      (state.companyFiles || []).filter((file) => !deletedSourceIds.has(file.id))
    ),
    fuelRecords: sortByXatDateTime(state.fuelRecords || [], (record) => ({
      xatDateTimeSort: record.entryDateSort || record.recordedAtSort || 0,
      name: record.station || record.driverName || '',
    })),
    expenseRecords: sortByXatDateTime(state.expenseRecords || [], (record) => ({
      xatDateTimeSort: record.entryDateSort || record.recordedAtSort || 0,
      name: record.vendor || record.category || '',
    })),
    paycheckRecords: sortByXatDateTime(state.paycheckRecords || [], (record) => ({
      xatDateTimeSort: record.endDateSort || record.recordedAtSort || 0,
      name: record.driverName || '',
    })),
    recycleBin: activeRecycleBin,
    purgedRecycleIds,
    restoredRecycleIds,
    clearedMoveIds,
    deletedSourceIdsState: Array.from(deletedSourceIds),
  };
}

function mergeSharedStates(localState = {}, remoteState = {}) {
  const accounts = mergeAccounts(localState.accounts, remoteState.accounts || []);
  const purgedRecycleIds = mergeStringLists(
    localState.purgedRecycleIds,
    remoteState.purgedRecycleIds || []
  );
  const restoredRecycleIds = mergeStringLists(
    localState.restoredRecycleIds,
    remoteState.restoredRecycleIds || []
  );
  const clearedMoveIds = mergeStringLists(
    localState.clearedMoveIds,
    remoteState.clearedMoveIds || []
  );
  const deletedSourceIdsState = mergeStringLists(
    localState.deletedSourceIdsState,
    remoteState.deletedSourceIdsState || []
  );

  return normalizeSharedStateShape({
    ...remoteState,
    accounts,
    moves: mergeRecordsById(localState.moves, remoteState.moves || []),
    waitRecords: mergeRecordsById(localState.waitRecords, remoteState.waitRecords || []),
    savedFiles: mergeRecordsById(localState.savedFiles, remoteState.savedFiles || []),
    waitSavedFiles: mergeRecordsById(localState.waitSavedFiles, remoteState.waitSavedFiles || []),
    companyFiles: mergeRecordsById(localState.companyFiles, remoteState.companyFiles || []),
    fuelRecords: mergeRecordsById(localState.fuelRecords, remoteState.fuelRecords || []),
    expenseRecords: mergeRecordsById(localState.expenseRecords, remoteState.expenseRecords || []),
    paycheckRecords: mergeRecordsById(localState.paycheckRecords, remoteState.paycheckRecords || []),
    messages: mergeRecordsById(localState.messages, remoteState.messages || []),
    recycleBin: mergeRecycleItems(localState.recycleBin, remoteState.recycleBin || []),
    purgedRecycleIds,
    restoredRecycleIds,
    clearedMoveIds,
    deletedSourceIdsState,
    adminNotificationEmail:
      localState.adminNotificationEmail ||
      remoteState.adminNotificationEmail ||
      DEFAULT_ADMIN_ACCOUNT.email,
  });
}

function cloneMoveRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    moveNumber: row.moveNumber,
    driverName: row.driverName,
    origin: row.origin,
    containerNumber: row.containerNumber,
    destination: row.destination,
    miles: row.miles,
    xatDateTime: row.xatDateTime,
    xatDateTimeSort: row.xatDateTimeSort,
    dateAdded: row.dateAdded,
    recordedAt: row.recordedAt,
    recordedAtSort: row.recordedAtSort,
    screenshots: row.screenshots || [],
  }));
}

function buildWorksheetRows(rows, headers) {
  return rows.map((row) =>
    headers.reduce((result, header) => {
      result[header.label] = row[header.key] ?? '';
      return result;
    }, {})
  );
}

function createWorkbookDownloadUrl(workbook) {
  const workbookArray = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([workbookArray], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  return URL.createObjectURL(blob);
}

function triggerWorkbookDownload(fileName, objectUrl) {
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `${fileName}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function buildWorkbookDownload(fileName, rows, headers) {
  const workbook = XLSX.utils.book_new();
  const normalizedRows = buildWorksheetRows(rows, headers);
  const worksheet = XLSX.utils.json_to_sheet(normalizedRows);
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Data');
  return {
    fileName,
    url: createWorkbookDownloadUrl(workbook),
  };
}

function buildCombinedWorkbookDownload(fileName, files, headers) {
  const workbook = XLSX.utils.book_new();
  files.forEach((file, index) => {
    const normalizedRows = buildWorksheetRows(file.rows, headers);
    const worksheet = XLSX.utils.json_to_sheet(normalizedRows);
    const safeSheetName = String(file.name || `File ${index + 1}`).slice(0, 31) || `File ${index + 1}`;
    XLSX.utils.book_append_sheet(workbook, worksheet, safeSheetName);
  });
  return {
    fileName,
    url: createWorkbookDownloadUrl(workbook),
  };
}

function extractMoveNumbersFromText(text) {
  return [...new Set((toUpperWords(text).match(/\b\d{6,}(?:-\d+)?\b/g) || []).map(normalizeMoveNumber))];
}

async function extractTextFromPdf(file) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf');
  const data = await file.arrayBuffer();
  pdfjsLib.GlobalWorkerOptions.workerSrc = `${process.env.PUBLIC_URL || ''}/pdf.worker.min.js`;

  const pdf = await pdfjsLib.getDocument({
    data,
    disableWorker: true,
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;

  const pageTexts = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);

    try {
      const content = await page.getTextContent();
      const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
      pageTexts.push(text);
      if (text.trim()) {
        continue;
      }
    } catch (error) {
      pageTexts.push('');
    }

    // Fallback OCR for PDFs that don't expose selectable text.
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) {
      continue;
    }

    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    await page.render({
      canvasContext: context,
      viewport,
    }).promise;

    const ocrResult = await Tesseract.recognize(canvas.toDataURL('image/png'), 'eng');
    const ocrText = ocrResult?.data?.text || '';
    if (ocrText.trim()) {
      pageTexts[pageTexts.length - 1] = ocrText;
    }
  }

  return pageTexts.join('\n').trim();
}

async function readFileAsText(file) {
  return file.text();
}

async function extractTextFromSpreadsheet(file) {
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: 'array' });
  return workbook.SheetNames.map((name) => XLSX.utils.sheet_to_csv(workbook.Sheets[name])).join('\n');
}

async function extractTextFromWord(file) {
  const data = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: data });
  return result.value || '';
}

async function extractTextFromDocument(file) {
  const name = file.name.toLowerCase();

  if (file.type.startsWith('image/') || /\.(png|jpg|jpeg|webp|bmp)$/i.test(name)) {
    const imageData = await fileToPreview(file);
    const ocrResult = await Tesseract.recognize(imageData.previewUrl, 'eng');
    return ocrResult?.data?.text || '';
  }

  if (file.type === 'application/pdf' || /\.pdf$/i.test(name)) {
    return extractTextFromPdf(file);
  }

  if (
    /\.(xlsx|xls|csv)$/i.test(name) ||
    file.type.includes('spreadsheet') ||
    file.type.includes('excel') ||
    file.type === 'text/csv'
  ) {
    return extractTextFromSpreadsheet(file);
  }

  if (/\.docx$/i.test(name)) {
    return extractTextFromWord(file);
  }

  if (/\.txt$/i.test(name) || file.type.startsWith('text/')) {
    return readFileAsText(file);
  }

  throw new Error('Unsupported file type');
}

function App() {
  const requestedLoginFace =
    LOGIN_FACE_PARAM === 'admin' || LOGIN_FACE_PARAM === 'driver'
      ? LOGIN_FACE_PARAM
      : DEFAULT_LOGIN_FACE;
  const initialTimestamp = getTimestampParts();
  const savedState = (() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  })();
  const initialAccounts = savedState?.accounts?.length ? savedState.accounts : [DEFAULT_ADMIN_ACCOUNT];
  const savedCurrentUserId =
    savedState?.currentUserId === '' || !savedState?.currentUserId ? '' : savedState.currentUserId;
  const savedCurrentUser =
    initialAccounts.find((account) => account.id === savedCurrentUserId) || null;
  const initialCurrentUserId =
    requestedLoginFace === 'admin'
      ? savedCurrentUser?.role === 'admin'
        ? savedCurrentUserId
        : ''
      : savedCurrentUserId;
  const initialCurrentUser =
    initialAccounts.find((account) => account.id === initialCurrentUserId) || null;
  const initialSelectedDriver =
    savedState?.selectedDriver && initialAccounts.some((account) => account.name === savedState.selectedDriver)
      ? savedState.selectedDriver
      : initialCurrentUser?.name || '';

  const [moves, setMoves] = useState(
    (savedState?.moves || starterMoves).filter((move) => (move.screenshots?.length || 0) > 0)
  );
  const [waitRecords, setWaitRecords] = useState(
    (savedState?.waitRecords || []).filter((record) => (record.screenshots?.length || 0) > 0)
  );
  const [activeTab, setActiveTab] = useState('capture');
  const [search, setSearch] = useState('');
  const [waitSearch, setWaitSearch] = useState('');
  const [selectedImage, setSelectedImage] = useState(null);
  const [clock, setClock] = useState(initialTimestamp.display);
  const [accounts, setAccounts] = useState(initialAccounts);
  const driverOptions = useMemo(
    () => accounts.filter((account) => account.role === 'driver').map((account) => account.name),
    [accounts]
  );
  const [currentUserId, setCurrentUserId] = useState(initialCurrentUserId);
  const currentUser = useMemo(
    () => accounts.find((account) => account.id === currentUserId) || null,
    [accounts, currentUserId]
  );
  const isAdminUser = currentUser?.role === 'admin';
  const selectableDrivers = useMemo(() => {
    if (!currentUser) {
      return [];
    }
    if (currentUser.role === 'admin') {
      return driverOptions.length ? driverOptions : [currentUser.name];
    }
    return [currentUser.name];
  }, [currentUser, driverOptions]);
  const [portalFace, setPortalFace] = useState(savedState?.portalFace || 'driver');
  const [selectedDriver, setSelectedDriver] = useState(initialSelectedDriver);
  const [savedFiles, setSavedFiles] = useState(savedState?.savedFiles || []);
  const [waitSavedFiles, setWaitSavedFiles] = useState(savedState?.waitSavedFiles || []);
  const [messages, setMessages] = useState(savedState?.messages || []);
  const [recycleBin, setRecycleBin] = useState(savedState?.recycleBin || []);
  const [purgedRecycleIds, setPurgedRecycleIds] = useState(savedState?.purgedRecycleIds || []);
  const [restoredRecycleIds, setRestoredRecycleIds] = useState(savedState?.restoredRecycleIds || []);
  const [clearedMoveIds, setClearedMoveIds] = useState(savedState?.clearedMoveIds || []);
  const [deletedSourceIdsState, setDeletedSourceIdsState] = useState(
    savedState?.deletedSourceIdsState || []
  );
  const [selectedRecycleIds, setSelectedRecycleIds] = useState([]);
  const [messageDraft, setMessageDraft] = useState('');
  const [messageSearch, setMessageSearch] = useState('');
  const [driverListSearch, setDriverListSearch] = useState('');
  const [selectedMessageDriverNames, setSelectedMessageDriverNames] = useState([]);
  const accountsRef = useRef(accounts);
  const sharedStateRef = useRef(null);
  const isApplyingRemoteStateRef = useRef(false);
  const sharedStateReadyRef = useRef(false);
  const [newDriverName, setNewDriverName] = useState('');
  const [newDriverEmail, setNewDriverEmail] = useState('');
  const [newDriverUsername, setNewDriverUsername] = useState('');
  const [newDriverPassword, setNewDriverPassword] = useState(generatePassword());
  const [optionsDialogOpen, setOptionsDialogOpen] = useState(false);
  const [optionsView, setOptionsView] = useState('register');
  const [adminNotificationEmail, setAdminNotificationEmail] = useState(
    savedState?.adminNotificationEmail || DEFAULT_ADMIN_ACCOUNT.email
  );
  const [editingAccountId, setEditingAccountId] = useState('');
  const [accountDraft, setAccountDraft] = useState(null);
  const [portalMenuOpen, setPortalMenuOpen] = useState(false);
  const [movesMenuOpen, setMovesMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileSidebarView, setMobileSidebarView] = useState('menu');
  const [isPhoneViewport, setIsPhoneViewport] = useState(window.innerWidth <= 640);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [backendReady, setBackendReady] = useState(false);
  const [forgotPasswordOpen, setForgotPasswordOpen] = useState(false);
  const [authDialogMode, setAuthDialogMode] = useState('forgot');
  const [forgotPasswordEmail, setForgotPasswordEmail] = useState('');
  const [passwordChangeIdentifier, setPasswordChangeIdentifier] = useState('');
  const [passwordChangeCurrent, setPasswordChangeCurrent] = useState('');
  const [passwordChangeNext, setPasswordChangeNext] = useState('');
  const [moveDownloadLinks, setMoveDownloadLinks] = useState([]);
  const [waitDownloadLinks, setWaitDownloadLinks] = useState([]);
  const [selectedSavedFileIds, setSelectedSavedFileIds] = useState([]);
  const [selectedWaitSavedFileIds, setSelectedWaitSavedFileIds] = useState([]);
  const [openFileMenuId, setOpenFileMenuId] = useState('');
  const [openWaitFileMenuId, setOpenWaitFileMenuId] = useState('');
  const [renameFileId, setRenameFileId] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [renameWaitFileId, setRenameWaitFileId] = useState('');
  const [renameWaitDraft, setRenameWaitDraft] = useState('');
  const [companyFiles, setCompanyFiles] = useState(savedState?.companyFiles || []);
  const [fuelRecords, setFuelRecords] = useState(savedState?.fuelRecords || []);
  const [expenseRecords, setExpenseRecords] = useState(savedState?.expenseRecords || []);
  const [paycheckRecords, setPaycheckRecords] = useState(savedState?.paycheckRecords || []);
  const [fuelForm, setFuelForm] = useState(createEmptyFuelForm(initialSelectedDriver));
  const [expenseForm, setExpenseForm] = useState(createEmptyExpenseForm(initialSelectedDriver));
  const [paycheckForm, setPaycheckForm] = useState(createEmptyPaycheckForm(initialSelectedDriver));
  const [fuelNotice, setFuelNotice] = useState('Add fuel receipts or manual fuel entries for daily tracking.');
  const [expenseNotice, setExpenseNotice] = useState('Add truck receipts or manual expenses for yearly totals.');
  const [weatherInfo, setWeatherInfo] = useState(null);
  const [weatherNotice, setWeatherNotice] = useState('Weather is ready when location is allowed.');
  const [selectedCompanyFileIds, setSelectedCompanyFileIds] = useState([]);
  const [openCompanyMenuId, setOpenCompanyMenuId] = useState('');
  const [renameCompanyFileId, setRenameCompanyFileId] = useState('');
  const [renameCompanyDraft, setRenameCompanyDraft] = useState('');
  const [comparisonRequested, setComparisonRequested] = useState(false);
  const [notice, setNotice] = useState(
    'Upload screenshots and OCR will read text automatically before you save to the table.'
  );
  const [form, setForm] = useState(createEmptyForm(initialSelectedDriver));
  const [waitNotice, setWaitNotice] = useState(
    'Upload wait-time screenshots and the app will calculate wait time automatically.'
  );
  const [waitForm, setWaitForm] = useState(createEmptyForm(initialSelectedDriver));
  const [editingMoveId, setEditingMoveId] = useState('');
  const [moveDraft, setMoveDraft] = useState(null);
  const [editingWaitId, setEditingWaitId] = useState('');
  const [waitDraft, setWaitDraft] = useState(null);
  const fileInputRef = useRef(null);
  const waitFileInputRef = useRef(null);
  const pdfInputRef = useRef(null);
  const recordRowRefs = useRef({});
  const waitRowRefs = useRef({});
  const captureOcrSessionRef = useRef(0);
  const waitOcrSessionRef = useRef(0);
  const sidebarRef = useRef(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClock(new Date().toLocaleString());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!navigator.geolocation) {
      setWeatherNotice('Weather needs browser location support.');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const { latitude, longitude } = position.coords;
          const response = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,precipitation,wind_speed_10m`
          );
          const result = await response.json();
          setWeatherInfo(result.current || null);
          setWeatherNotice('Live weather updated.');
        } catch {
          setWeatherNotice('Live weather could not load right now.');
        }
      },
      () => setWeatherNotice('Allow location to show live weather.')
    );
  }, []);

  useEffect(() => {
    const handleResize = () => {
      const nextIsPhone = window.innerWidth <= 640;
      setIsPhoneViewport(nextIsPhone);
      if (!nextIsPhone) {
        setMobileSidebarView('menu');
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          accounts,
          currentUserId,
          portalFace,
          selectedDriver,
          adminNotificationEmail,
        })
      );
    } catch {
      // Mobile/private browsers can reject storage when large screenshot data exists.
      // The backend remains the source of truth, so the app should keep running.
    }
  }, [
    accounts,
    adminNotificationEmail,
    currentUserId,
    portalFace,
    selectedDriver,
  ]);

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  useEffect(() => {
    sharedStateRef.current = {
      accounts,
      moves,
      waitRecords,
      savedFiles,
      waitSavedFiles,
      companyFiles,
      fuelRecords,
      expenseRecords,
      paycheckRecords,
      messages,
      recycleBin,
      purgedRecycleIds,
      restoredRecycleIds,
      clearedMoveIds,
      deletedSourceIdsState,
      adminNotificationEmail,
    };
  }, [
    accounts,
    adminNotificationEmail,
    clearedMoveIds,
    companyFiles,
    expenseRecords,
    fuelRecords,
    deletedSourceIdsState,
    messages,
    moves,
    paycheckRecords,
    purgedRecycleIds,
    restoredRecycleIds,
    recycleBin,
    savedFiles,
    waitRecords,
    waitSavedFiles,
  ]);

  useEffect(() => {
    let active = true;

    const checkBackend = async () => {
      try {
        await fetchBackendHealth();
        if (active) {
          setBackendReady(true);
        }
      } catch {
        if (active) {
          setBackendReady(false);
        }
      }
    };

    checkBackend();
    const intervalId = window.setInterval(checkBackend, 5000);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let active = true;

    const applyRemoteState = (remoteState) => {
      const normalizedRemoteState = normalizeSharedStateShape({
        ...remoteState,
        accounts: mergeAccounts(accountsRef.current, remoteState.accounts || []),
      });
      const nextPurgedRecycleIds = normalizedRemoteState.purgedRecycleIds || [];
      const nextRestoredRecycleIds = normalizedRemoteState.restoredRecycleIds || [];
      const nextClearedMoveIds = normalizedRemoteState.clearedMoveIds || [];
      const nextDeletedSourceIdsState = normalizedRemoteState.deletedSourceIdsState || [];
      const nextAccounts = normalizedRemoteState.accounts;
      isApplyingRemoteStateRef.current = true;
      setAccounts(nextAccounts);
      setMoves(normalizedRemoteState.moves || []);
      setWaitRecords(normalizedRemoteState.waitRecords || []);
      setSavedFiles(normalizedRemoteState.savedFiles || []);
      setWaitSavedFiles(normalizedRemoteState.waitSavedFiles || []);
      setCompanyFiles(normalizedRemoteState.companyFiles || []);
      setFuelRecords(normalizedRemoteState.fuelRecords || []);
      setExpenseRecords(normalizedRemoteState.expenseRecords || []);
      setPaycheckRecords(normalizedRemoteState.paycheckRecords || []);
      setMessages(normalizedRemoteState.messages || []);
      setRecycleBin(normalizedRemoteState.recycleBin || []);
      setPurgedRecycleIds(nextPurgedRecycleIds);
      setRestoredRecycleIds(nextRestoredRecycleIds);
      setClearedMoveIds(nextClearedMoveIds);
      setDeletedSourceIdsState(nextDeletedSourceIdsState);
      setAdminNotificationEmail(normalizedRemoteState.adminNotificationEmail || DEFAULT_ADMIN_ACCOUNT.email);
      sharedStateRef.current = {
        accounts: nextAccounts,
        moves: normalizedRemoteState.moves || [],
        waitRecords: normalizedRemoteState.waitRecords || [],
        savedFiles: normalizedRemoteState.savedFiles || [],
        waitSavedFiles: normalizedRemoteState.waitSavedFiles || [],
        companyFiles: normalizedRemoteState.companyFiles || [],
        fuelRecords: normalizedRemoteState.fuelRecords || [],
        expenseRecords: normalizedRemoteState.expenseRecords || [],
        paycheckRecords: normalizedRemoteState.paycheckRecords || [],
        messages: normalizedRemoteState.messages || [],
        recycleBin: normalizedRemoteState.recycleBin || [],
        purgedRecycleIds: nextPurgedRecycleIds,
        restoredRecycleIds: nextRestoredRecycleIds,
        clearedMoveIds: nextClearedMoveIds,
        deletedSourceIdsState: nextDeletedSourceIdsState,
        adminNotificationEmail: normalizedRemoteState.adminNotificationEmail || DEFAULT_ADMIN_ACCOUNT.email,
      };
      window.setTimeout(() => {
        isApplyingRemoteStateRef.current = false;
      }, 0);
    };

    const syncSharedStateFromBackend = async () => {
      try {
        const remoteState = await fetchSharedState();
        if (!active) {
          return;
        }

        const currentState = sharedStateRef.current;
        if (!currentState) {
          applyRemoteState(remoteState);
          sharedStateReadyRef.current = true;
          return;
        }

        const remoteSnapshot = JSON.stringify(remoteState);
        const currentSnapshot = JSON.stringify(currentState);

        if (remoteSnapshot !== currentSnapshot) {
          const mergedState = mergeSharedStates(currentState, remoteState);
          const mergedSnapshot = JSON.stringify(mergedState);

          if (mergedSnapshot !== remoteSnapshot) {
            const savedState = await saveSharedState(mergedState);
            if (active) {
              applyRemoteState(savedState);
            }
          } else {
            applyRemoteState(remoteState);
          }
        }

        sharedStateReadyRef.current = true;
      } catch {
        sharedStateReadyRef.current = true;
      }
    };

    syncSharedStateFromBackend();
    const intervalId = window.setInterval(syncSharedStateFromBackend, 5000);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!sharedStateReadyRef.current || isApplyingRemoteStateRef.current || !sharedStateRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      saveSharedState(sharedStateRef.current).catch(() => {
        // Keep local fallback if the backend is not reachable.
      });
    }, 400);

    return () => window.clearTimeout(timeoutId);
  }, [
    accounts,
    adminNotificationEmail,
    clearedMoveIds,
    companyFiles,
    expenseRecords,
    fuelRecords,
    deletedSourceIdsState,
    messages,
    moves,
    paycheckRecords,
    purgedRecycleIds,
    restoredRecycleIds,
    recycleBin,
    savedFiles,
    waitRecords,
    waitSavedFiles,
  ]);

  useEffect(() => {
    if (!currentUser || !selectableDrivers.length) {
      return;
    }

    if (currentUser.role === 'driver') {
      if (selectedDriver !== currentUser.name) {
        setSelectedDriver(currentUser.name);
      }
      if (portalFace !== 'driver') {
        setPortalFace('driver');
      }
      return;
    }

    if (!selectableDrivers.includes(selectedDriver)) {
      setSelectedDriver(selectableDrivers[0]);
    }
  }, [currentUser, portalFace, selectableDrivers, selectedDriver]);

  useEffect(() => {
    setFuelForm((prev) => ({ ...prev, driverName: selectedDriver || prev.driverName }));
    setExpenseForm((prev) => ({ ...prev, driverName: selectedDriver || prev.driverName }));
    setPaycheckForm((prev) => ({ ...prev, driverName: selectedDriver || prev.driverName }));
  }, [selectedDriver]);

  useEffect(() => {
    const now = Date.now();
    const maxAdminAge = 30 * 24 * 60 * 60 * 1000;
    setRecycleBin((prev) => prev.filter((item) => !item?.deletedAtSort || now - item.deletedAtSort <= maxAdminAge));
  }, []);

  useEffect(() => {
    if (
      sharedStateReadyRef.current &&
      currentUserId &&
      accounts.length > 1 &&
      !accounts.some((account) => account.id === currentUserId)
    ) {
      setCurrentUserId('');
      setPortalFace('driver');
      setSelectedDriver('');
    }
  }, [accounts, currentUserId]);

  useEffect(() => {
    if (currentUser?.role === 'driver' && currentUser.appBlocked) {
      setCurrentUserId('');
      setPortalFace('driver');
      setSelectedDriver('');
      setAuthError('Unable to open your app. Contact with your admin.');
    }
  }, [currentUser]);

  const handleDriverChange = (driverName) => {
    setSelectedDriver(driverName);
    setForm((prev) => ({ ...prev, driverName }));
    setWaitForm((prev) => ({ ...prev, driverName }));
    setEditingMoveId('');
    setMoveDraft(null);
    setEditingWaitId('');
    setWaitDraft(null);
  };

  const handlePortalFaceChange = (face) => {
    setPortalFace(face);
    setPortalMenuOpen(false);
    setMovesMenuOpen(false);
    setMobileMenuOpen(false);
    setMobileSidebarView('menu');
  };

  const resetAdminSidebar = () => {
    setPortalMenuOpen(false);
    setMovesMenuOpen(false);
    setOptionsDialogOpen(false);
    setMobileMenuOpen(false);
    setMobileSidebarView('menu');
  };

  const scrollSidebarBy = (offset) => {
    if (sidebarRef.current) {
      sidebarRef.current.scrollBy({ top: offset, behavior: 'smooth' });
    }
  };

  const handleLogin = async () => {
    if (authBusy) {
      return;
    }
    setAuthBusy(true);
    let latestAccounts = accounts;

    try {
      const remoteState = await fetchSharedState();
      if (remoteState?.accounts?.length) {
        latestAccounts = remoteState.accounts;
        setAccounts(remoteState.accounts);
      }
    } catch {
      setAuthError('Online login service is waking up or unavailable. Wait one minute, then try again.');
      setAuthBusy(false);
      return;
    }

    const matchedAccount = latestAccounts.find(
      (account) =>
        (normalizeEmail(account.email) === normalizeEmail(loginEmail) ||
          normalizeName(account.username) === normalizeName(loginEmail)) &&
        account.password === loginPassword.trim()
    );

    if (!matchedAccount) {
      setAuthError('Wrong email or password.');
      setAuthBusy(false);
      return;
    }

    if (matchedAccount.role === 'driver' && matchedAccount.appBlocked) {
      setAuthError('Unable to open your app. Contact with your admin.');
      setAuthBusy(false);
      return;
    }

    if (requestedLoginFace === 'driver' && matchedAccount.role === 'admin') {
      setAuthError('Use the admin login link for the admin account.');
      setAuthBusy(false);
      return;
    }

    if (requestedLoginFace === 'admin' && matchedAccount.role !== 'admin') {
      setAuthError('Use the driver login link for driver accounts.');
      setAuthBusy(false);
      return;
    }

    setCurrentUserId(matchedAccount.id);
    setPortalFace(matchedAccount.role === 'admin' ? 'admin' : 'driver');
    setSelectedDriver(matchedAccount.name);
    setLoginEmail('');
    setLoginPassword('');
    setAuthError('');
    setForgotPasswordOpen(false);
    setAuthBusy(false);
  };

  const handleLogout = () => {
    setCurrentUserId('');
    setPortalFace('driver');
    setSelectedDriver(DEFAULT_ADMIN_ACCOUNT.name);
    setAuthError('');
    setMobileMenuOpen(false);
    setMobileSidebarView('menu');
    setNotice('Signed out.');
    setWaitNotice('Signed out.');
  };

  const handleLoginKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleLogin();
    }
  };

  const openAuthDialog = (mode) => {
    setAuthDialogMode(mode);
    setForgotPasswordOpen(true);
    setForgotPasswordEmail(mode === 'forgot' ? loginEmail : '');
    setPasswordChangeIdentifier(loginEmail);
    setPasswordChangeCurrent(loginPassword);
    setPasswordChangeNext('');
  };

  const closeAuthDialog = () => {
    setForgotPasswordOpen(false);
    setForgotPasswordEmail('');
    setPasswordChangeIdentifier('');
    setPasswordChangeCurrent('');
    setPasswordChangeNext('');
  };

  const handleChangePasswordFromLogin = async () => {
    if (authBusy) {
      return;
    }
    const identifier = passwordChangeIdentifier.trim();
    const currentPassword = passwordChangeCurrent.trim();
    const nextPassword = passwordChangeNext.trim();

    if (!identifier || !currentPassword || !nextPassword) {
      setAuthError('Enter email or username, current password, and new password.');
      return;
    }

    setAuthBusy(true);
    let latestAccounts = accounts;

    try {
      const remoteState = await fetchSharedState();
      if (remoteState?.accounts?.length) {
        latestAccounts = remoteState.accounts;
        setAccounts(remoteState.accounts);
      }
    } catch {
      setAuthError('Online login service is waking up or unavailable. Wait one minute, then try again.');
      setAuthBusy(false);
      return;
    }

    const matchedAccount = latestAccounts.find(
      (account) =>
        (normalizeEmail(account.email) === normalizeEmail(identifier) ||
          normalizeName(account.username) === normalizeName(identifier)) &&
        account.password === currentPassword
    );

    if (!matchedAccount) {
      setAuthError('Current email/username or password is wrong.');
      setAuthBusy(false);
      return;
    }

    const timestamp = Date.now();
    const nextAccounts = buildUpdatedAccounts(latestAccounts, matchedAccount.id, (account) => ({
      ...account,
      password: nextPassword,
      accountUpdatedAtSort: timestamp,
    }));

    try {
      const savedAccounts = await saveSharedAccounts(nextAccounts);
      setAccounts(savedAccounts);
      setLoginEmail(matchedAccount.email);
      setLoginPassword('');
      closeAuthDialog();
      setAuthError('Password changed successfully. You can now log in with the new password.');
    } catch (error) {
      setAuthError(`Could not change password. ${error.message}`);
    } finally {
      setAuthBusy(false);
    }
  };

  const registerDriver = async () => {
    const driverName = normalizeName(newDriverName);
    const driverEmail = normalizeEmail(newDriverEmail);
    const driverUsername = normalizeName(newDriverUsername);
    const driverPassword = newDriverPassword.trim() || generatePassword();
    const timestamp = Date.now();

    if (!driverName || !driverEmail || !driverUsername) {
      setNotice('Enter driver name, email, and username first.');
      return;
    }

    if (
      accounts.some(
        (account) =>
          normalizeEmail(account.email) === driverEmail ||
          normalizeName(account.username) === driverUsername
      )
    ) {
      setNotice('That email or username is already registered.');
      return;
    }

    const nextDriver = {
      id: `driver-${Date.now()}`,
      role: 'driver',
      name: driverName,
      email: driverEmail,
      username: driverUsername,
      password: driverPassword,
      appBlocked: false,
      accountUpdatedAtSort: timestamp,
    };

    const nextAccounts = [...accounts, nextDriver];

    try {
      const savedAccounts = await saveSharedAccounts(nextAccounts);
      setAccounts(savedAccounts);
      setSelectedDriver(driverName);
      setNewDriverName('');
      setNewDriverEmail('');
      setNewDriverUsername('');
      setNewDriverPassword(generatePassword());
      setOptionsDialogOpen(false);
      setNotice(`Registered driver ${driverName}. Sending email...`);
    } catch (error) {
      setNotice(`Could not save ${driverName} to the shared driver list. ${error.message}`);
      return;
    }

    try {
      const result = await sendDriverRegistrationEmail({
        driverName,
        driverEmail,
        username: driverUsername,
        password: driverPassword,
        adminEmail: normalizeEmail(adminNotificationEmail),
      });
      setNotice(`Registered driver ${driverName}. ${result.message}`);
    } catch (error) {
      setNotice(`Registered driver ${driverName}, but email was not sent. ${error.message}`);
    }
  };

  const openOptionsDialogWithView = (view) => {
    setOptionsView(view);
    setEditingAccountId('');
    setAccountDraft(null);
    if (isPhoneViewport) {
      setMobileMenuOpen(true);
      setMobileSidebarView('options');
      return;
    }
    setOptionsDialogOpen(true);
  };

  const resetDriverPassword = (accountId) => {
    const nextPassword = generatePassword();
    const timestamp = Date.now();
    let resetDriverName = '';
    const nextAccounts = accounts.map((account) => {
      if (account.id !== accountId) {
        return account;
      }
      resetDriverName = account.name;
      return { ...account, password: nextPassword, accountUpdatedAtSort: timestamp };
    });

    saveSharedAccounts(nextAccounts)
      .then((savedAccounts) => {
        setAccounts(savedAccounts);
        if (resetDriverName) {
          setNotice(`Password reset for ${resetDriverName}. New password: ${nextPassword}`);
        }
      })
      .catch((error) => {
        setNotice(`Could not reset password in the shared driver list. ${error.message}`);
      });
  };

  const setDriverAppAccess = (accountId, appBlocked) => {
    const targetAccount = accounts.find((account) => account.id === accountId);
    if (!targetAccount) {
      return;
    }

    const timestamp = Date.now();
    const nextAccounts = buildUpdatedAccounts(accounts, accountId, (account) => ({
      ...account,
      appBlocked,
      accountUpdatedAtSort: timestamp,
    }));

    setAccounts(nextAccounts);

    saveSharedAccounts(nextAccounts)
      .then((savedAccounts) => {
        setAccounts(savedAccounts);
        setNotice(
          appBlocked
            ? `${targetAccount.name} app access is now blocked.`
            : `${targetAccount.name} app access is now allowed.`
        );
      })
      .catch((error) => {
        setAccounts(accounts);
        setNotice(`Could not update app access for ${targetAccount.name}. ${error.message}`);
      });
  };

  const startEditingAccount = (account) => {
    setEditingAccountId(account.id);
    setAccountDraft({
      name: account.name,
      email: account.email,
      username: account.username || '',
      password: account.password || '',
      appBlocked: Boolean(account.appBlocked),
    });
  };

  const saveEditedAccount = () => {
    if (!editingAccountId || !accountDraft) {
      return;
    }

    const nextName = normalizeName(accountDraft.name);
    const nextEmail = normalizeEmail(accountDraft.email);
    const nextUsername = normalizeName(accountDraft.username);
    const nextPassword = accountDraft.password.trim();
    const nextBlocked = Boolean(accountDraft.appBlocked);
    const timestamp = Date.now();

    if (!nextName || !nextEmail || !nextUsername || !nextPassword) {
      setNotice('Enter name, email, username, and password before saving.');
      return;
    }

    const conflict = accounts.some(
      (account) =>
        account.id !== editingAccountId &&
        (normalizeEmail(account.email) === nextEmail ||
          normalizeName(account.username) === nextUsername)
    );

    if (conflict) {
      setNotice('That email or username is already used by another driver.');
      return;
    }

    const previousName = accounts.find((account) => account.id === editingAccountId)?.name;
    const nextAccounts = accounts.map((account) =>
      account.id === editingAccountId
        ? {
            ...account,
            name: nextName,
            email: nextEmail,
            username: nextUsername,
            password: nextPassword,
            appBlocked: nextBlocked,
            accountUpdatedAtSort: timestamp,
          }
        : account
    );

    saveSharedAccounts(nextAccounts)
      .then((savedAccounts) => {
        setAccounts(savedAccounts);
        if (selectedDriver === previousName) {
          setSelectedDriver(nextName);
        }
        setEditingAccountId('');
        setAccountDraft(null);
        setNotice(`Updated ${nextName}.`);
      })
      .catch((error) => {
        setNotice(`Could not update the shared driver list. ${error.message}`);
      });
  };

  const messageDriverAccounts = useMemo(
    () => accounts.filter((account) => account.role === 'driver'),
    [accounts]
  );

  const filteredMessageDriverAccounts = useMemo(() => {
    const query = driverListSearch.trim().toLowerCase();
    return messageDriverAccounts.filter((account) =>
      !query
        ? true
        : [account.name, account.email, account.username || ''].join(' ').toLowerCase().includes(query)
    );
  }, [driverListSearch, messageDriverAccounts]);

  const selectedMessages = useMemo(() => {
    if (!currentUser) {
      return [];
    }

    if (currentUser.role === 'admin' && portalFace === 'admin') {
      const query = messageSearch.toLowerCase().trim();
      return messages.filter((message) => {
        const matchesDrivers =
          !selectedMessageDriverNames.length || selectedMessageDriverNames.includes(message.driverName);
        const matchesQuery = !query
          ? true
          : [message.driverName, message.senderName, message.body]
              .join(' ')
              .toLowerCase()
              .includes(query);
        return matchesDrivers && matchesQuery;
      });
    }

    const ownMessages = messages.filter((message) => message.driverName === selectedDriver);
    return ownMessages.slice(-100);
  }, [currentUser, messageSearch, messages, portalFace, selectedDriver, selectedMessageDriverNames]);

  const sendMessage = () => {
    const trimmedBody = messageDraft.trim();
    if (!trimmedBody) {
      return;
    }

    const timestamp = getTimestampParts();
    const targetDriverName = currentUser.role === 'admin' && portalFace === 'admin' ? selectedDriver : currentUser.name;
    const nextMessage = {
      id: `message-${Date.now()}`,
      driverName: targetDriverName,
      senderRole: currentUser.role,
      senderName: currentUser.name,
      body: trimmedBody,
      createdAt: timestamp.display,
      createdAtSort: timestamp.sortValue,
    };

    setMessages((prev) => [...prev, nextMessage]);
    setMessageDraft('');
  };

  const toggleMessageDriverSelection = (driverName) => {
    setSelectedMessageDriverNames((prev) =>
      prev.includes(driverName) ? prev.filter((name) => name !== driverName) : [...prev, driverName]
    );
  };

  const confirmDriverMessageSelection = () => {
    if (selectedMessageDriverNames.length) {
      setSelectedDriver(selectedMessageDriverNames[0]);
    }
    setActiveTab('messages');
  };

  const renderHighlightedText = (value, query) => {
    const text = String(value ?? '');
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      return text;
    }

    const lowerText = text.toLowerCase();
    const lowerQuery = trimmedQuery.toLowerCase();
    const parts = [];
    let startIndex = 0;
    let matchIndex = lowerText.indexOf(lowerQuery);

    if (matchIndex === -1) {
      return text;
    }

    while (matchIndex !== -1) {
      if (matchIndex > startIndex) {
        parts.push(text.slice(startIndex, matchIndex));
      }

      const matchEnd = matchIndex + trimmedQuery.length;
      parts.push(
        <mark key={`${text}-${matchIndex}`} className="search-mark">
          {text.slice(matchIndex, matchEnd)}
        </mark>
      );
      startIndex = matchEnd;
      matchIndex = lowerText.indexOf(lowerQuery, matchEnd);
    }

    if (startIndex < text.length) {
      parts.push(text.slice(startIndex));
    }

    return parts;
  };

  const resetForm = (message = 'Ready for the next move capture.') => {
    captureOcrSessionRef.current += 1;
    setForm(createEmptyForm(selectedDriver));
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    setNotice(message);
  };

  const resetWaitForm = (
    message = 'Ready for the next wait-time capture.',
    clearDriverWaitRows = false
  ) => {
    waitOcrSessionRef.current += 1;
    setWaitForm(createEmptyForm(selectedDriver));
    if (waitFileInputRef.current) {
      waitFileInputRef.current.value = '';
    }
    if (clearDriverWaitRows) {
      setWaitRecords((prev) => prev.filter((record) => record.driverName !== selectedDriver));
      setWaitSearch('');
      setEditingWaitId('');
      setWaitDraft(null);
    }
    setWaitNotice(message);
  };

  const runOcrForScreenshot = async (shotName, previewUrl) => {
    try {
      const result = await Tesseract.recognize(previewUrl, 'eng');
      const text = result?.data?.text || '';
      return {
        ocrStatus: 'done',
        ocrText: text,
        extracted: deriveFieldsFromText(text, shotName),
      };
    } catch {
      return {
        ocrStatus: 'error',
        ocrText: '',
        extracted: deriveFieldsFromText('', shotName),
      };
    }
  };

  const runOcrForWaitScreenshot = async (shotName, previewUrl) => {
    try {
      const result = await Tesseract.recognize(previewUrl, 'eng');
      const text = result?.data?.text || '';
      return {
        ocrStatus: 'done',
        ocrText: text,
        extracted: deriveWaitFieldsFromText(text, shotName),
      };
    } catch {
      return {
        ocrStatus: 'error',
        ocrText: '',
        extracted: deriveWaitFieldsFromText('', shotName),
      };
    }
  };

  const handleFilesChange = async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      return;
    }

    const sessionId = captureOcrSessionRef.current + 1;
    captureOcrSessionRef.current = sessionId;

    const availableSlots = Math.max(MAX_SCREENSHOTS - form.screenshots.length, 0);
    const limitedFiles = files.slice(0, availableSlots);
    const preparedFiles = await Promise.all(limitedFiles.map(fileToPreview));
    const queuedFiles = preparedFiles.map((shot) => ({
      ...shot,
      ocrStatus: 'processing',
      ocrText: '',
      extracted: deriveFieldsFromText('', shot.name),
    }));

    setForm((prev) => ({
      ...prev,
      screenshots: [...prev.screenshots, ...queuedFiles].slice(0, MAX_SCREENSHOTS),
    }));

    setNotice(
      `${queuedFiles.length} screenshot(s) added. OCR is reading move text from the images now.`
    );

    queuedFiles.forEach(async (shot) => {
      const ocrResult = await runOcrForScreenshot(shot.name, shot.previewUrl);
      if (captureOcrSessionRef.current !== sessionId) {
        return;
      }
      setForm((prev) => ({
        ...prev,
        screenshots: sortByXatDateTime(
          prev.screenshots.map((currentShot) =>
            currentShot.previewUrl === shot.previewUrl ? { ...currentShot, ...ocrResult } : currentShot
          )
        ),
      }));
    });

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeScreenshot = (previewUrl) => {
    setForm((prev) => {
      const removedShot = prev.screenshots.find((shot) => shot.previewUrl === previewUrl);
      if (removedShot) {
        setRecycleBin((current) => [createDeletedItem('screenshot', removedShot), ...current]);
      }
      return {
        ...prev,
        screenshots: prev.screenshots.filter((shot) => shot.previewUrl !== previewUrl),
      };
    });
  };

  const handleWaitFilesChange = async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      return;
    }

    const sessionId = waitOcrSessionRef.current + 1;
    waitOcrSessionRef.current = sessionId;

    const availableSlots = Math.max(MAX_SCREENSHOTS - waitForm.screenshots.length, 0);
    const limitedFiles = files.slice(0, availableSlots);
    const preparedFiles = await Promise.all(limitedFiles.map(fileToPreview));
    const queuedFiles = preparedFiles.map((shot) => ({
      ...shot,
      ocrStatus: 'processing',
      ocrText: '',
      extracted: deriveWaitFieldsFromText('', shot.name),
    }));

    setWaitForm((prev) => ({
      ...prev,
      screenshots: [...prev.screenshots, ...queuedFiles].slice(0, MAX_SCREENSHOTS),
    }));

    setWaitNotice(
      `${queuedFiles.length} wait screenshot(s) added. OCR is reading XAT, arrival, release, depart, and move details now.`
    );

    queuedFiles.forEach(async (shot) => {
      const ocrResult = await runOcrForWaitScreenshot(shot.name, shot.previewUrl);
      if (waitOcrSessionRef.current !== sessionId) {
        return;
      }
      setWaitForm((prev) => ({
        ...prev,
        screenshots: prev.screenshots.map((currentShot) =>
          currentShot.previewUrl === shot.previewUrl ? { ...currentShot, ...ocrResult } : currentShot
        ),
      }));
    });

    if (waitFileInputRef.current) {
      waitFileInputRef.current.value = '';
    }
  };

  const removeWaitScreenshot = (previewUrl) => {
    setWaitForm((prev) => {
      const removedShot = prev.screenshots.find((shot) => shot.previewUrl === previewUrl);
      if (removedShot) {
        setRecycleBin((current) => [createDeletedItem('wait-screenshot', removedShot), ...current]);
      }
      return {
        ...prev,
        screenshots: prev.screenshots.filter((shot) => shot.previewUrl !== previewUrl),
      };
    });
  };

  const saveMove = () => {
    if (!form.screenshots.length) {
      setNotice('Add at least 1 screenshot before saving to the move records table.');
      return;
    }

    const processingShots = form.screenshots.filter((shot) => shot.ocrStatus === 'processing');
    if (processingShots.length) {
      setNotice('Wait until OCR finishes for all screenshots, then save to the move records table.');
      return;
    }

    const createdAt = getTimestampParts();
    const uniqueShots = form.screenshots.filter((shot, index, array) => {
      const shotSignature = getShotSignature(shot);
      return index === array.findIndex((current) => getShotSignature(current) === shotSignature);
    });
    const existingShotSignatures = new Set(
      moves.flatMap((move) => move.screenshots?.map((shot) => getShotSignature(shot)) || [])
    );
    const freshShots = uniqueShots.filter((shot) => !existingShotSignatures.has(getShotSignature(shot)));
    const nextMoves = freshShots.map((shot, index) => {
      const extracted = shot.extracted || deriveFieldsFromText(shot.ocrText || '', shot.name);
      const cleanMoveNumber =
        pickCleanMoveNumber(extracted.moveNumber, shot.ocrText, shot.name) ||
        `PENDING-${createdAt.sortValue}-${index + 1}`;
      return {
        id: `${Date.now()}-${index}`,
        moveNumber: cleanMoveNumber,
        driverName: selectedDriver,
        origin: extracted.origin || '-',
        containerNumber: extracted.containerNumber || '-',
        destination: extracted.destination || '-',
        miles: extracted.miles || '-',
        xatDateTime: extracted.xatDateTime || '-',
        xatDateTimeSort: extracted.xatDateTimeSort || 0,
        dateAdded: form.entryDate || createdAt.dateOnly,
        recordedAt: createdAt.display,
        recordedAtSort: createdAt.sortValue + index,
        screenshots: [shot],
      };
    });

    if (!nextMoves.length) {
      setNotice('Those screenshots were already saved. No duplicate move rows were added.');
      setActiveTab('records');
      resetForm();
      return;
    }

    setMoves((prev) => sortByXatDateTime(dedupeMoveRecords([...nextMoves, ...prev])));
    setActiveTab('records');
    resetForm(
      `Saved ${nextMoves.length} move record(s) for ${selectedDriver}.`
    );
  };

  const saveWaitRecords = () => {
    if (!waitForm.screenshots.length) {
      setWaitNotice('Add at least 1 screenshot before saving to the wait-time table.');
      return;
    }

    const createdAt = getTimestampParts();
    const nextWaitRecords = waitForm.screenshots.map((shot, index) => {
      const extracted = shot.extracted || deriveWaitFieldsFromText(shot.ocrText || '', shot.name);
      return {
        id: `wait-${Date.now()}-${index}`,
        moveNumber: extracted.moveNumber || `WAIT-${createdAt.sortValue}-${index + 1}`,
        driverName: extracted.driverName || selectedDriver,
        origin: extracted.origin || '-',
        containerNumber: extracted.containerNumber || '-',
        destination: extracted.destination || '-',
        xatDateTime: extracted.xatDateTime || '-',
        arrivalTime: extracted.arrivalTime || '-',
        releaseTime: extracted.releaseTime || '-',
        departTime: extracted.departTime || '-',
        waitTime: extracted.waitTime || '-',
        waitMinutes: extracted.waitMinutes ?? null,
        recordedAt: createdAt.display,
        recordedAtSort: createdAt.sortValue + index,
        screenshots: [shot],
      };
    });

    setWaitRecords((prev) => [...nextWaitRecords, ...prev]);
    resetWaitForm(`Saved ${nextWaitRecords.length} wait record(s) for ${selectedDriver}.`);
  };

  const handleFuelReceiptUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const receipt = await fileToPreview(file);
    setFuelForm((prev) => ({ ...prev, receipt }));
    setFuelNotice('Reading fuel receipt for KM, litres, and total...');

    try {
      const result = await Tesseract.recognize(receipt.previewUrl, 'eng');
      const extracted = deriveFuelFieldsFromText(result?.data?.text || '', file.name);
      setFuelForm((prev) => ({
        ...prev,
        entryDate: extracted.entryDate || prev.entryDate,
        km: extracted.km || prev.km,
        fuelQuantity: extracted.fuelQuantity || prev.fuelQuantity,
        fuelCost: extracted.fuelCost || prev.fuelCost,
        station: extracted.station || prev.station,
        receipt: { ...receipt, ocrText: result?.data?.text || '', extracted },
      }));
      setFuelNotice('Fuel receipt extracted. Check the values, then save fuel entry.');
    } catch {
      setFuelNotice('Fuel receipt OCR failed. You can still type fuel manually.');
    }
  };

  const handleExpenseReceiptUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const receipt = await fileToPreview(file);
    setExpenseForm((prev) => ({ ...prev, receipt }));
    setExpenseNotice('Reading expense receipt for vendor and total...');

    try {
      const result = await Tesseract.recognize(receipt.previewUrl, 'eng');
      const extracted = deriveExpenseFieldsFromText(result?.data?.text || '', file.name);
      setExpenseForm((prev) => ({
        ...prev,
        entryDate: extracted.entryDate || prev.entryDate,
        vendor: extracted.vendor || prev.vendor,
        total: extracted.total || prev.total,
        receipt: { ...receipt, ocrText: result?.data?.text || '', extracted },
      }));
      setExpenseNotice('Expense receipt extracted. Check the values, then save expense.');
    } catch {
      setExpenseNotice('Expense receipt OCR failed. You can still type the expense manually.');
    }
  };

  const saveFuelRecord = () => {
    const createdAt = getTimestampParts();
    const nextRecord = {
      id: `fuel-${createdAt.sortValue}`,
      driverName: selectedDriver,
      entryDate: fuelForm.entryDate || createdAt.dateOnly,
      entryDateSort: dateInputToSort(fuelForm.entryDate || createdAt.dateOnly),
      km: fuelForm.km || '-',
      fuelQuantity: fuelForm.fuelQuantity || '-',
      fuelCost: fuelForm.fuelCost || '-',
      station: fuelForm.station || '-',
      notes: fuelForm.notes || '',
      receipt: fuelForm.receipt,
      recordedAt: createdAt.display,
      recordedAtSort: createdAt.sortValue,
    };
    setFuelRecords((prev) => sortByXatDateTime([nextRecord, ...prev], (record) => ({
      xatDateTimeSort: record.entryDateSort || record.recordedAtSort || 0,
      name: record.station || '',
    })));
    setFuelForm(createEmptyFuelForm(selectedDriver));
    setFuelNotice('Fuel entry saved.');
  };

  const saveExpenseRecord = () => {
    const createdAt = getTimestampParts();
    const nextRecord = {
      id: `expense-${createdAt.sortValue}`,
      driverName: selectedDriver,
      entryDate: expenseForm.entryDate || createdAt.dateOnly,
      entryDateSort: dateInputToSort(expenseForm.entryDate || createdAt.dateOnly),
      category: expenseForm.category || 'Truck Receipt',
      vendor: expenseForm.vendor || '-',
      total: expenseForm.total || '-',
      notes: expenseForm.notes || '',
      receipt: expenseForm.receipt,
      recordedAt: createdAt.display,
      recordedAtSort: createdAt.sortValue,
    };
    setExpenseRecords((prev) => sortByXatDateTime([nextRecord, ...prev], (record) => ({
      xatDateTimeSort: record.entryDateSort || record.recordedAtSort || 0,
      name: record.vendor || '',
    })));
    setExpenseForm(createEmptyExpenseForm(selectedDriver));
    setExpenseNotice('Expense saved.');
  };

  const savePaycheckRecord = () => {
    const createdAt = getTimestampParts();
    const nextRecord = {
      id: `paycheck-${createdAt.sortValue}`,
      driverName: selectedDriver,
      startDate: paycheckForm.startDate,
      startDateSort: dateInputToSort(paycheckForm.startDate),
      endDate: paycheckForm.endDate,
      endDateSort: dateInputToSort(paycheckForm.endDate),
      paycheckAmount: paycheckForm.paycheckAmount || '-',
      notes: paycheckForm.notes || '',
      recordedAt: createdAt.display,
      recordedAtSort: createdAt.sortValue,
    };
    setPaycheckRecords((prev) => sortByXatDateTime([nextRecord, ...prev], (record) => ({
      xatDateTimeSort: record.endDateSort || record.recordedAtSort || 0,
      name: record.driverName || '',
    })));
    setPaycheckForm(createEmptyPaycheckForm(selectedDriver));
  };

  const filteredMoves = useMemo(() => {
    const query = search.toLowerCase().trim();
    return sortByXatDateTime(
      dedupeMoveRecords(moves).filter((move) => {
        if (move.driverName !== selectedDriver || !move.screenshots?.length) {
          return false;
        }

        return !query
          ? true
          : [
              move.moveNumber,
              move.driverName,
              move.origin,
              move.containerNumber,
              move.destination,
              move.miles,
              move.xatDateTime,
              move.dateAdded,
              move.recordedAt,
            ]
              .join(' ')
              .toLowerCase()
              .includes(query);
      })
    );
  }, [moves, search, selectedDriver]);

  const filteredWaitRecords = useMemo(() => {
    const query = waitSearch.toLowerCase().trim();
    return waitRecords.filter((record) => {
      if (record.driverName !== selectedDriver || !record.screenshots?.length) {
        return false;
      }

      return !query
        ? true
        : [
            record.moveNumber,
            record.driverName,
            record.origin,
            record.containerNumber,
            record.destination,
            record.xatDateTime,
            record.arrivalTime,
            record.releaseTime,
            record.departTime,
            record.waitTime,
            record.recordedAt,
          ]
            .join(' ')
            .toLowerCase()
            .includes(query);
    });
  }, [waitRecords, waitSearch, selectedDriver]);

  const selectedFuelRecords = useMemo(
    () => fuelRecords.filter((record) => record.driverName === selectedDriver),
    [fuelRecords, selectedDriver]
  );

  const selectedExpenseRecords = useMemo(
    () => expenseRecords.filter((record) => record.driverName === selectedDriver),
    [expenseRecords, selectedDriver]
  );

  const selectedPaycheckRecords = useMemo(
    () => paycheckRecords.filter((record) => record.driverName === selectedDriver),
    [paycheckRecords, selectedDriver]
  );

  const dailyMiles = useMemo(() => {
    const totals = new Map();
    filteredMoves.forEach((move) => {
      const key = move.xatDateTime?.match(/\d{4}-\d{2}-\d{2}/)?.[0] || move.dateAdded || 'No date';
      const miles = Number(String(move.miles || '').replace(/[^\d.]/g, '')) || 0;
      totals.set(key, (totals.get(key) || 0) + miles);
    });
    return Array.from(totals.entries())
      .map(([date, miles]) => ({ date, miles }))
      .sort((a, b) => dateInputToSort(a.date) - dateInputToSort(b.date));
  }, [filteredMoves]);

  const fuelSummary = useMemo(() => {
    const sorted = [...selectedFuelRecords].sort((a, b) => (a.entryDateSort || 0) - (b.entryDateSort || 0));
    const totalFuel = sorted.reduce((sum, record) => sum + (Number(record.fuelQuantity) || 0), 0);
    const totalCost = sorted.reduce((sum, record) => sum + (Number(record.fuelCost) || 0), 0);
    const firstKm = Number(sorted[0]?.km) || 0;
    const lastKm = Number(sorted[sorted.length - 1]?.km) || 0;
    const kmDriven = Math.max(0, lastKm - firstKm);
    const avgKmPerFuelUnit = totalFuel ? kmDriven / totalFuel : 0;
    const recentGap =
      sorted.length >= 2
        ? Math.max(0, (Number(sorted[sorted.length - 1].km) || 0) - (Number(sorted[sorted.length - 2].km) || 0))
        : 0;
    const nextFillKm = lastKm && recentGap ? lastKm + recentGap : 0;
    return { totalFuel, totalCost, kmDriven, avgKmPerFuelUnit, nextFillKm };
  }, [selectedFuelRecords]);

  const yearlyExpenseTotal = useMemo(() => {
    const year = new Date().getFullYear();
    return selectedExpenseRecords
      .filter((record) => String(record.entryDate || '').startsWith(String(year)))
      .reduce((sum, record) => sum + (Number(record.total) || 0), 0);
  }, [selectedExpenseRecords]);

  const paycheckComparisons = useMemo(
    () =>
      selectedPaycheckRecords.map((paycheck) => {
        const miles = filteredMoves.reduce((sum, move) => {
          const sort = move.xatDateTimeSort || move.recordedAtSort || 0;
          if (sort < paycheck.startDateSort || sort > paycheck.endDateSort + 24 * 60 * 60 * 1000) {
            return sum;
          }
          return sum + (Number(String(move.miles || '').replace(/[^\d.]/g, '')) || 0);
        }, 0);
        const amount = Number(paycheck.paycheckAmount) || 0;
        return {
          ...paycheck,
          miles,
          payPerMile: miles ? amount / miles : 0,
        };
      }),
    [filteredMoves, selectedPaycheckRecords]
  );

  const sortedCaptureScreenshots = useMemo(
    () => sortByXatDateTime(form.screenshots, (shot) => shot.extracted || shot),
    [form.screenshots]
  );

  const sortedWaitScreenshots = useMemo(
    () => sortByXatDateTime(waitForm.screenshots, (shot) => shot.extracted || shot),
    [waitForm.screenshots]
  );

  useEffect(() => {
    const query = search.trim();
    if (!query || !filteredMoves.length) {
      return;
    }

    const firstMatchRow = recordRowRefs.current[filteredMoves[0].id];
    if (firstMatchRow) {
      firstMatchRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [filteredMoves, search]);

  useEffect(() => {
    const query = waitSearch.trim();
    if (!query || !filteredWaitRecords.length) {
      return;
    }

    const firstMatchRow = waitRowRefs.current[filteredWaitRecords[0].id];
    if (firstMatchRow) {
      firstMatchRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [filteredWaitRecords, waitSearch]);

  const selectedDriverMoves = useMemo(
    () =>
      dedupeMoveRecords(moves)
        .filter((move) => move.driverName === selectedDriver && move.screenshots?.length)
        .sort((a, b) => (a.xatDateTimeSort || a.recordedAtSort || 0) - (b.xatDateTimeSort || b.recordedAtSort || 0)),
    [moves, selectedDriver]
  );

  const selectedDriverWaitRecords = useMemo(
    () =>
      waitRecords
        .filter((record) => record.driverName === selectedDriver && record.screenshots?.length)
        .sort((a, b) => (b.recordedAtSort || 0) - (a.recordedAtSort || 0)),
    [waitRecords, selectedDriver]
  );

  const deletedSourceIds = useMemo(
    () =>
      new Set([
        ...deletedSourceIdsState,
        ...recycleBin.map((item) => item.sourceId).filter(Boolean),
      ]),
    [deletedSourceIdsState, recycleBin]
  );
  const visibleRecycleBin = useMemo(() => {
    const now = Date.now();
    const maxAge = isAdminUser && portalFace === 'admin' ? 30 * 24 * 60 * 60 * 1000 : 14 * 24 * 60 * 60 * 1000;
    return recycleBin.filter((item) => {
      if (!item?.deletedAtSort) {
        return true;
      }
      if (!(isAdminUser && portalFace === 'admin') && item.driverName && item.driverName !== selectedDriver) {
        return false;
      }
      return now - item.deletedAtSort <= maxAge;
    });
  }, [recycleBin, isAdminUser, portalFace, selectedDriver]);

  useEffect(() => {
    if (selectedRecycleIds.some((id) => !visibleRecycleBin.some((item) => item.id === id))) {
      setSelectedRecycleIds((prev) => prev.filter((id) => visibleRecycleBin.some((item) => item.id === id)));
    }
  }, [selectedRecycleIds, visibleRecycleBin]);
  const selectedDriverWaitSavedFiles = useMemo(
    () =>
      waitSavedFiles
        .filter((file) => file.driverName === selectedDriver && !deletedSourceIds.has(file.id))
        .sort((a, b) => (b.updatedAtSort || 0) - (a.updatedAtSort || 0)),
    [waitSavedFiles, selectedDriver, deletedSourceIds]
  );

  const selectedSavedFiles = useMemo(
    () => savedFiles.filter((file) => selectedSavedFileIds.includes(file.id)),
    [savedFiles, selectedSavedFileIds]
  );

  const selectedCompanyFiles = useMemo(
    () =>
      companyFiles.filter(
        (file) => selectedCompanyFileIds.includes(file.id) && !deletedSourceIds.has(file.id)
      ),
    [companyFiles, selectedCompanyFileIds, deletedSourceIds]
  );
  const visibleCompanyFiles = useMemo(
    () =>
      companyFiles
        .filter((file) => !deletedSourceIds.has(file.id))
        .sort((a, b) => (b.updatedAtSort || 0) - (a.updatedAtSort || 0)),
    [companyFiles, deletedSourceIds]
  );

  const companyMoveNumbers = useMemo(
    () => [...new Set(selectedCompanyFiles.flatMap((file) => file.moveNumbers || []))],
    [selectedCompanyFiles]
  );

  const activeComparisonRows = useMemo(
    () =>
      selectedSavedFiles.length
        ? selectedSavedFiles.flatMap((file) => file.rows)
        : selectedDriverMoves,
    [selectedSavedFiles, selectedDriverMoves]
  );

  const screenshotExtraMoves = useMemo(() => {
    if (!companyMoveNumbers.length) {
      return [];
    }

    const pdfMoveSet = new Set(companyMoveNumbers.map(normalizeMoveNumber));
    return activeComparisonRows.filter(
      (move) => !pdfMoveSet.has(normalizeMoveNumber(move.moveNumber))
    );
  }, [companyMoveNumbers, activeComparisonRows]);

  const matchedComparisonMoves = useMemo(() => {
    if (!companyMoveNumbers.length) {
      return [];
    }

    const pdfMoveSet = new Set(companyMoveNumbers.map(normalizeMoveNumber));
    const matchedByMoveNumber = new Map();
    activeComparisonRows.forEach((move) => {
      const normalizedMoveNumber = normalizeMoveNumber(move.moveNumber);
      if (normalizedMoveNumber && pdfMoveSet.has(normalizedMoveNumber)) {
        matchedByMoveNumber.set(normalizedMoveNumber, move);
      }
    });

    return Array.from(matchedByMoveNumber.values());
  }, [companyMoveNumbers, activeComparisonRows]);

  const companyExtraMoves = useMemo(() => {
    if (!companyMoveNumbers.length) {
      return [];
    }

    const selectedMoveSet = new Set(
      activeComparisonRows.map((move) => normalizeMoveNumber(move.moveNumber))
    );

    return companyMoveNumbers.filter(
      (moveNumber) => !selectedMoveSet.has(normalizeMoveNumber(moveNumber))
    );
  }, [companyMoveNumbers, activeComparisonRows]);

  const selectedDriverSavedFiles = useMemo(
    () =>
      savedFiles
        .filter((file) => file.driverName === selectedDriver && !deletedSourceIds.has(file.id))
        .sort((a, b) => (b.updatedAtSort || 0) - (a.updatedAtSort || 0)),
    [savedFiles, selectedDriver, deletedSourceIds]
  );

  useEffect(() => {
    if (
      selectedSavedFileIds.length &&
      selectedSavedFileIds.some((id) => !selectedDriverSavedFiles.some((file) => file.id === id))
    ) {
      setSelectedSavedFileIds((prev) =>
        prev.filter((id) => selectedDriverSavedFiles.some((file) => file.id === id))
      );
      setOpenFileMenuId('');
      setRenameFileId('');
      setRenameDraft('');
    }
  }, [selectedDriverSavedFiles, selectedSavedFileIds]);

  useEffect(() => {
    if (
      selectedWaitSavedFileIds.length &&
      selectedWaitSavedFileIds.some((id) => !selectedDriverWaitSavedFiles.some((file) => file.id === id))
    ) {
      setSelectedWaitSavedFileIds((prev) =>
        prev.filter((id) => selectedDriverWaitSavedFiles.some((file) => file.id === id))
      );
      setOpenWaitFileMenuId('');
      setRenameWaitFileId('');
      setRenameWaitDraft('');
    }
  }, [selectedDriverWaitSavedFiles, selectedWaitSavedFileIds]);

  useEffect(() => {
    if (
      selectedCompanyFileIds.length &&
      selectedCompanyFileIds.some((id) => !visibleCompanyFiles.some((file) => file.id === id))
    ) {
      setSelectedCompanyFileIds((prev) =>
        prev.filter((id) => visibleCompanyFiles.some((file) => file.id === id))
      );
      setOpenCompanyMenuId('');
      setRenameCompanyFileId('');
      setRenameCompanyDraft('');
    }
  }, [selectedCompanyFileIds, visibleCompanyFiles]);

  const ocrCompletedCount = form.screenshots.filter((shot) => shot.ocrStatus === 'done').length;
  const waitOcrCompletedCount = waitForm.screenshots.filter((shot) => shot.ocrStatus === 'done').length;

  const handleCompanyPdfUpload = async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      return;
    }

    setComparisonRequested(false);
    const parsedFiles = await Promise.all(
      files.map(async (file) => {
        try {
          const text = await extractTextFromDocument(file);
          const moveNumbers = extractMoveNumbersFromText(text);
          const timestamp = getTimestampParts();
          return {
            id: `company-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name,
            driverName: selectedDriver,
            status: 'done',
            moveNumbers,
            text,
            updatedAt: timestamp.display,
            updatedAtSort: timestamp.sortValue,
          };
        } catch {
          const timestamp = getTimestampParts();
          return {
            id: `company-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name,
            driverName: selectedDriver,
            status: 'error',
            moveNumbers: [],
            text: '',
            updatedAt: timestamp.display,
            updatedAtSort: timestamp.sortValue,
          };
        }
      })
    );

    const nextCompanyFiles = [...parsedFiles, ...companyFiles];
    setCompanyFiles(nextCompanyFiles);
    setSelectedCompanyFileIds((prev) => [
      ...new Set([...parsedFiles.filter((file) => file.status === 'done').map((file) => file.id), ...prev]),
    ]);
    sharedStateRef.current = {
      ...sharedStateRef.current,
      companyFiles: nextCompanyFiles,
    };
    saveSharedState(sharedStateRef.current).catch(() => {
      // Keep local company files if backend save is delayed.
    });

    const readyCount = parsedFiles.filter((file) => file.status === 'done').length;
    const failedCount = parsedFiles.length - readyCount;
    if (failedCount) {
      setNotice(
        `${readyCount} company file(s) ready and ${failedCount} failed. Supported compare files: PDF, DOCX, XLSX, XLS, CSV, TXT, and images.`
      );
    } else {
      setNotice(`${readyCount} company file(s) added for compare.`);
    }

    if (pdfInputRef.current) {
      pdfInputRef.current.value = '';
    }
  };

  const downloadMoveFilesToComputer = (fileIds) => {
    const filesToDownload = savedFiles.filter((file) => fileIds.includes(file.id));
    if (!filesToDownload.length) {
      setNotice('Select one or more saved move files first.');
      return;
    }

    const headers = [
      { key: 'moveNumber', label: 'Move #' },
      { key: 'driverName', label: 'Driver Name' },
      { key: 'origin', label: 'Origin' },
      { key: 'containerNumber', label: 'Container #' },
      { key: 'destination', label: 'Destination' },
      { key: 'miles', label: 'Miles' },
      { key: 'xatDateTime', label: 'XAT Date Time' },
      { key: 'recordedAt', label: 'Recorded At' },
    ];

    const downloads =
      filesToDownload.length === 1
        ? [buildWorkbookDownload(filesToDownload[0].name, filesToDownload[0].rows, headers)]
        : [buildCombinedWorkbookDownload(`${selectedDriver} MOVE FILES`, filesToDownload, headers)];

    setMoveDownloadLinks(downloads);
    downloads.forEach((download) => triggerWorkbookDownload(download.fileName, download.url));
    setNotice(
      `${filesToDownload.length} move file(s) prepared. If download is blocked, use the download link shown below.`
    );
  };

  const downloadWaitFilesToComputer = (fileIds) => {
    const filesToDownload = waitSavedFiles.filter((file) => fileIds.includes(file.id));
    if (!filesToDownload.length) {
      setWaitNotice('Select one or more wait files first.');
      return;
    }

    const headers = [
      { key: 'moveNumber', label: 'Move #' },
      { key: 'driverName', label: 'Driver Name' },
      { key: 'origin', label: 'Origin' },
      { key: 'containerNumber', label: 'Container #' },
      { key: 'destination', label: 'Destination' },
      { key: 'xatDateTime', label: 'XAT Date Time' },
      { key: 'arrivalTime', label: 'Arrival Time' },
      { key: 'releaseTime', label: 'Release Time' },
      { key: 'departTime', label: 'Depart Time' },
      { key: 'waitTime', label: 'Wait Time' },
      { key: 'recordedAt', label: 'Recorded At' },
    ];

    const downloads =
      filesToDownload.length === 1
        ? [buildWorkbookDownload(filesToDownload[0].name, filesToDownload[0].rows, headers)]
        : [buildCombinedWorkbookDownload(`${selectedDriver} WAIT FILES`, filesToDownload, headers)];

    setWaitDownloadLinks(downloads);
    downloads.forEach((download) => triggerWorkbookDownload(download.fileName, download.url));
    setWaitNotice(
      `${filesToDownload.length} wait file(s) prepared. If download is blocked, use the download link shown below.`
    );
  };

  const saveRecordsToSavedFiles = () => {
    if (!filteredMoves.length) {
      setNotice(`No move records are available to save for ${selectedDriver}.`);
      return;
    }

    const timestamp = getTimestampParts();
    const fileName = `${selectedDriver} ${timestamp.dateOnly} ${timestamp.sortValue}`;
    const nextFile = {
      id: `saved-${Date.now()}`,
      name: fileName,
      driverName: selectedDriver,
      rows: cloneMoveRows(filteredMoves),
      updatedAt: timestamp.display,
      updatedAtSort: timestamp.sortValue,
    };

    const nextSavedFiles = [nextFile, ...savedFiles];
    const nextDeletedSourceIdsState = deletedSourceIdsState.filter((id) => id !== nextFile.id);
    setSavedFiles(nextSavedFiles);
    setDeletedSourceIdsState(nextDeletedSourceIdsState);
    setSelectedSavedFileIds((prev) => [...new Set([nextFile.id, ...prev])]);
    setActiveTab('match');
    setComparisonRequested(false);
    sharedStateRef.current = {
      ...sharedStateRef.current,
      savedFiles: nextSavedFiles,
      deletedSourceIdsState: nextDeletedSourceIdsState,
    };
    saveSharedState(sharedStateRef.current).catch(() => {
      // Keep local saved file if backend save is delayed.
    });
    setNotice(`Saved records directly into Saved Files as "${fileName}".`);
  };

  const clearSelectedDriverRecords = () => {
    const driverMoves = moves.filter((move) => move.driverName === selectedDriver);
    const driverRecordCount = driverMoves.length;
    if (!driverRecordCount) {
      setNotice(`No move records are available to clear for ${selectedDriver}.`);
      return;
    }

    const idsToClear = driverMoves.map((move) => move.id);
    const nextClearedMoveIds = mergeStringLists(clearedMoveIds, idsToClear);
    const nextMoves = moves.filter((move) => !idsToClear.includes(move.id));
    setClearedMoveIds(nextClearedMoveIds);
    setMoves(nextMoves);
    setSearch('');
    sharedStateRef.current = normalizeSharedStateShape({
      ...sharedStateRef.current,
      moves: nextMoves,
      clearedMoveIds: nextClearedMoveIds,
    });
    saveSharedState(sharedStateRef.current).catch(() => {
      // Keep local clear if backend save is delayed.
    });
    setNotice(`Cleared ${driverRecordCount} move record(s) for ${selectedDriver}.`);
  };

  const startEditingMove = (move) => {
    setEditingMoveId(move.id);
    setMoveDraft({
      moveNumber: move.moveNumber,
      driverName: move.driverName,
      origin: move.origin,
      containerNumber: move.containerNumber,
      destination: move.destination,
      miles: move.miles,
    });
  };

  const saveEditedMove = () => {
    if (!editingMoveId || !moveDraft) {
      return;
    }

    setMoves((prev) =>
      prev.map((move) =>
        move.id === editingMoveId
          ? {
              ...move,
              moveNumber: moveDraft.moveNumber,
              driverName: moveDraft.driverName,
              origin: moveDraft.origin,
              containerNumber: moveDraft.containerNumber,
              destination: moveDraft.destination,
              miles: moveDraft.miles,
            }
          : move
      )
    );
    setEditingMoveId('');
    setMoveDraft(null);
    setNotice('Move record updated.');
  };

  const deleteMoveRecord = (moveId) => {
    const targetMove = moves.find((move) => move.id === moveId);
    if (!targetMove) {
      setNotice('That move is already removed.');
      return;
    }

    const nextClearedMoveIds = mergeStringLists(clearedMoveIds, [moveId]);
    const nextMoves = moves.filter((move) => move.id !== moveId);
    const nextRecycleBin = [createDeletedItem('move-record', targetMove), ...recycleBin];

    setMoves(nextMoves);
    setClearedMoveIds(nextClearedMoveIds);
    setRecycleBin(nextRecycleBin);
    setEditingMoveId('');
    setMoveDraft(null);
    sharedStateRef.current = normalizeSharedStateShape({
      ...sharedStateRef.current,
      moves: nextMoves,
      recycleBin: nextRecycleBin,
      clearedMoveIds: nextClearedMoveIds,
    });
    saveSharedState(sharedStateRef.current).catch(() => {
      // Keep local delete if backend save is delayed.
    });
    setNotice(`Removed move ${targetMove.moveNumber || ''}.`);
  };

  const startEditingWaitRecord = (record) => {
    setEditingWaitId(record.id);
    setWaitDraft({
      moveNumber: record.moveNumber,
      driverName: record.driverName,
      origin: record.origin,
      containerNumber: record.containerNumber,
      destination: record.destination,
      xatDateTime: record.xatDateTime,
      arrivalTime: record.arrivalTime,
      releaseTime: record.releaseTime,
      departTime: record.departTime,
    });
  };

  const saveEditedWaitRecord = () => {
    if (!editingWaitId || !waitDraft) {
      return;
    }

    const xatDateTime = parseDateTimeValue(waitDraft.xatDateTime);
    const arrivalDateTime = parseDateTimeValue(waitDraft.arrivalTime, xatDateTime);
    const releaseDateTime = parseDateTimeValue(waitDraft.releaseTime, xatDateTime || arrivalDateTime);
    const waitInfo = calculateWaitTime({ xatDateTime, arrivalDateTime, releaseDateTime });

    setWaitRecords((prev) =>
      prev.map((record) =>
        record.id === editingWaitId
          ? {
              ...record,
              moveNumber: waitDraft.moveNumber,
              driverName: waitDraft.driverName,
              origin: waitDraft.origin,
              containerNumber: waitDraft.containerNumber,
              destination: waitDraft.destination,
              xatDateTime: waitDraft.xatDateTime,
              arrivalTime: waitDraft.arrivalTime,
              releaseTime: waitDraft.releaseTime,
              departTime: waitDraft.departTime,
              waitTime: waitInfo.waitTime,
              waitMinutes: waitInfo.waitMinutes,
            }
          : record
      )
    );
    setEditingWaitId('');
    setWaitDraft(null);
    setWaitNotice('Wait record updated.');
  };

  const startRenameSavedFile = (file) => {
    setRenameFileId(file.id);
    setRenameDraft(file.name);
    setOpenFileMenuId('');
  };

  const saveRenamedFile = () => {
    if (!renameFileId || !renameDraft.trim()) {
      return;
    }

    const timestamp = getTimestampParts();
    setSavedFiles((prev) =>
      prev.map((file) =>
        file.id === renameFileId
          ? {
              ...file,
              name: renameDraft.trim(),
              updatedAt: timestamp.display,
              updatedAtSort: timestamp.sortValue,
            }
          : file
      )
    );
    setRenameFileId('');
    setRenameDraft('');
    setComparisonRequested(false);
    setNotice('Saved file renamed.');
  };

  const deleteSavedFile = (fileId) => {
    const targetFile = savedFiles.find((file) => file.id === fileId);
    const nextRecycleBin = targetFile
      ? [createDeletedItem('saved-file', targetFile), ...recycleBin]
      : recycleBin;
    const nextSavedFiles = savedFiles.filter((file) => file.id !== fileId);
    const nextDeletedSourceIdsState = mergeStringLists(deletedSourceIdsState, [fileId]);
    setRecycleBin(nextRecycleBin);
    setSavedFiles(nextSavedFiles);
    setDeletedSourceIdsState(nextDeletedSourceIdsState);
    setSelectedSavedFileIds((prev) => prev.filter((id) => id !== fileId));
    if (renameFileId === fileId) {
      setRenameFileId('');
      setRenameDraft('');
    }
    setOpenFileMenuId('');
    setComparisonRequested(false);
    sharedStateRef.current = {
      ...sharedStateRef.current,
      savedFiles: nextSavedFiles,
      recycleBin: nextRecycleBin,
      deletedSourceIdsState: nextDeletedSourceIdsState,
    };
    saveSharedState(sharedStateRef.current).catch(() => {
      // Keep local delete if backend save is delayed.
    });
    setNotice('Saved file deleted.');
  };

  const deleteSelectedSavedFiles = () => {
    if (!selectedSavedFileIds.length) {
      setNotice('Select one or more saved files first.');
      return;
    }

    const selectedSet = new Set(selectedSavedFileIds);
    const deletedItems = savedFiles.filter((file) => selectedSet.has(file.id));
    const nextRecycleBin = deletedItems.length
      ? [...deletedItems.map((file) => createDeletedItem('saved-file', file)), ...recycleBin]
      : recycleBin;
    const nextSavedFiles = savedFiles.filter((file) => !selectedSet.has(file.id));
    const nextDeletedSourceIdsState = mergeStringLists(
      deletedSourceIdsState,
      deletedItems.map((file) => file.id)
    );
    setRecycleBin(nextRecycleBin);
    setSavedFiles(nextSavedFiles);
    setDeletedSourceIdsState(nextDeletedSourceIdsState);
    setSelectedSavedFileIds([]);
    setOpenFileMenuId('');
    setRenameFileId('');
    setRenameDraft('');
    setComparisonRequested(false);
    sharedStateRef.current = {
      ...sharedStateRef.current,
      savedFiles: nextSavedFiles,
      recycleBin: nextRecycleBin,
      deletedSourceIdsState: nextDeletedSourceIdsState,
    };
    saveSharedState(sharedStateRef.current).catch(() => {
      // Keep local delete if backend save is delayed.
    });
    setNotice(`${deletedItems.length} saved file(s) deleted.`);
  };

  const startRenameWaitFile = (file) => {
    setRenameWaitFileId(file.id);
    setRenameWaitDraft(file.name);
    setOpenWaitFileMenuId('');
  };

  const saveRenamedWaitFile = () => {
    if (!renameWaitFileId || !renameWaitDraft.trim()) {
      return;
    }

    const timestamp = getTimestampParts();
    setWaitSavedFiles((prev) =>
      prev.map((file) =>
        file.id === renameWaitFileId
          ? {
              ...file,
              name: renameWaitDraft.trim(),
              updatedAt: timestamp.display,
              updatedAtSort: timestamp.sortValue,
            }
          : file
      )
    );
    setRenameWaitFileId('');
    setRenameWaitDraft('');
    setWaitNotice('Wait file renamed.');
  };

  const deleteWaitFile = (fileId) => {
    const targetFile = waitSavedFiles.find((file) => file.id === fileId);
    const nextRecycleBin = targetFile
      ? [createDeletedItem('wait-file', targetFile), ...recycleBin]
      : recycleBin;
    const nextWaitSavedFiles = waitSavedFiles.filter((file) => file.id !== fileId);
    const nextDeletedSourceIdsState = mergeStringLists(deletedSourceIdsState, [fileId]);
    setRecycleBin(nextRecycleBin);
    setWaitSavedFiles(nextWaitSavedFiles);
    setDeletedSourceIdsState(nextDeletedSourceIdsState);
    setSelectedWaitSavedFileIds((prev) => prev.filter((id) => id !== fileId));
    if (renameWaitFileId === fileId) {
      setRenameWaitFileId('');
      setRenameWaitDraft('');
    }
    setOpenWaitFileMenuId('');
    sharedStateRef.current = {
      ...sharedStateRef.current,
      waitSavedFiles: nextWaitSavedFiles,
      recycleBin: nextRecycleBin,
      deletedSourceIdsState: nextDeletedSourceIdsState,
    };
    saveSharedState(sharedStateRef.current).catch(() => {
      // Keep local delete if backend save is delayed.
    });
    setWaitNotice('Wait file deleted.');
  };

  const deleteSelectedWaitFiles = () => {
    if (!selectedWaitSavedFileIds.length) {
      setWaitNotice('Select one or more wait files first.');
      return;
    }

    const selectedSet = new Set(selectedWaitSavedFileIds);
    const deletedItems = waitSavedFiles.filter((file) => selectedSet.has(file.id));
    const nextRecycleBin = deletedItems.length
      ? [...deletedItems.map((file) => createDeletedItem('wait-file', file)), ...recycleBin]
      : recycleBin;
    const nextWaitSavedFiles = waitSavedFiles.filter((file) => !selectedSet.has(file.id));
    const nextDeletedSourceIdsState = mergeStringLists(
      deletedSourceIdsState,
      deletedItems.map((file) => file.id)
    );
    setRecycleBin(nextRecycleBin);
    setWaitSavedFiles(nextWaitSavedFiles);
    setDeletedSourceIdsState(nextDeletedSourceIdsState);
    setSelectedWaitSavedFileIds([]);
    setOpenWaitFileMenuId('');
    setRenameWaitFileId('');
    setRenameWaitDraft('');
    sharedStateRef.current = {
      ...sharedStateRef.current,
      waitSavedFiles: nextWaitSavedFiles,
      recycleBin: nextRecycleBin,
      deletedSourceIdsState: nextDeletedSourceIdsState,
    };
    saveSharedState(sharedStateRef.current).catch(() => {
      // Keep local delete if backend save is delayed.
    });
    setWaitNotice(`${deletedItems.length} wait file(s) deleted.`);
  };

  const startRenameCompanyFile = (file) => {
    setRenameCompanyFileId(file.id);
    setRenameCompanyDraft(file.name);
    setOpenCompanyMenuId('');
  };

  const saveRenamedCompanyFile = () => {
    if (!renameCompanyFileId || !renameCompanyDraft.trim()) {
      return;
    }

    const timestamp = getTimestampParts();
    const nextCompanyFiles = companyFiles.map((file) =>
        file.id === renameCompanyFileId
          ? {
              ...file,
              name: renameCompanyDraft.trim(),
              updatedAt: timestamp.display,
              updatedAtSort: timestamp.sortValue,
            }
          : file
      );
    setCompanyFiles(nextCompanyFiles);
    sharedStateRef.current = {
      ...sharedStateRef.current,
      companyFiles: nextCompanyFiles,
    };
    saveSharedState(sharedStateRef.current).catch(() => {
      // Keep local rename if backend save is delayed.
    });
    setRenameCompanyFileId('');
    setRenameCompanyDraft('');
    setComparisonRequested(false);
    setNotice('Company file renamed.');
  };

  const deleteCompanyFile = (fileId) => {
    const targetFile = companyFiles.find((file) => file.id === fileId);
    const nextRecycleBin = targetFile
      ? [createDeletedItem('company-file', targetFile), ...recycleBin]
      : recycleBin;
    const nextCompanyFiles = companyFiles.filter((file) => file.id !== fileId);
    const nextDeletedSourceIdsState = mergeStringLists(deletedSourceIdsState, [fileId]);
    setRecycleBin(nextRecycleBin);
    setCompanyFiles(nextCompanyFiles);
    setDeletedSourceIdsState(nextDeletedSourceIdsState);
    setSelectedCompanyFileIds((prev) => prev.filter((id) => id !== fileId));
    if (renameCompanyFileId === fileId) {
      setRenameCompanyFileId('');
      setRenameCompanyDraft('');
    }
    setOpenCompanyMenuId('');
    setComparisonRequested(false);
    sharedStateRef.current = {
      ...sharedStateRef.current,
      companyFiles: nextCompanyFiles,
      recycleBin: nextRecycleBin,
      deletedSourceIdsState: nextDeletedSourceIdsState,
    };
    saveSharedState(sharedStateRef.current).catch(() => {
      // Keep local delete if backend save is delayed.
    });
    setNotice('Company file deleted.');
  };

  const restoreRecycleItems = () => {
    if (!selectedRecycleIds.length) {
      setNotice('Select one or more deleted items first.');
      return;
    }

    const itemsToRestore = recycleBin.filter((item) => selectedRecycleIds.includes(item.id));
    let nextSavedFiles = savedFiles;
    let nextWaitSavedFiles = waitSavedFiles;
    let nextCompanyFiles = companyFiles;
    let nextMoves = moves;
    let nextRecycleBin = recycleBin.filter((item) => !selectedRecycleIds.includes(item.id));
    const restoredSourceIds = [];

    itemsToRestore.forEach((item) => {
      if (!item?.payload) {
        return;
      }
      if (item.type === 'saved-file') {
        restoredSourceIds.push(item.payload.id);
        nextSavedFiles = nextSavedFiles.some((file) => file.id === item.payload.id)
          ? nextSavedFiles
          : [item.payload, ...nextSavedFiles];
      } else if (item.type === 'wait-file') {
        restoredSourceIds.push(item.payload.id);
        nextWaitSavedFiles = nextWaitSavedFiles.some((file) => file.id === item.payload.id)
          ? nextWaitSavedFiles
          : [item.payload, ...nextWaitSavedFiles];
      } else if (item.type === 'company-file') {
        restoredSourceIds.push(item.payload.id);
        nextCompanyFiles = nextCompanyFiles.some((file) => file.id === item.payload.id)
          ? nextCompanyFiles
          : [item.payload, ...nextCompanyFiles];
      } else if (item.type === 'move-record') {
        restoredSourceIds.push(item.payload.id);
        nextMoves = sortByXatDateTime(
          dedupeMoveRecords(
            nextMoves.some((move) => move.id === item.payload.id)
              ? nextMoves
              : [item.payload, ...nextMoves]
          )
        );
      } else if (item.type === 'screenshot') {
        setForm((prev) => ({
          ...prev,
          screenshots: prev.screenshots.some((shot) => shot.previewUrl === item.payload.previewUrl)
            ? prev.screenshots
            : [...prev.screenshots, item.payload].slice(0, MAX_SCREENSHOTS),
        }));
      } else if (item.type === 'wait-screenshot') {
        setWaitForm((prev) => ({
          ...prev,
          screenshots: prev.screenshots.some((shot) => shot.previewUrl === item.payload.previewUrl)
            ? prev.screenshots
            : [...prev.screenshots, item.payload].slice(0, MAX_SCREENSHOTS),
        }));
      }
    });

    const nextPurgedRecycleIds = purgedRecycleIds.filter((id) => !selectedRecycleIds.includes(id));
    const nextRestoredRecycleIds = mergeStringLists(restoredRecycleIds, selectedRecycleIds);
    const nextDeletedSourceIdsState = deletedSourceIdsState.filter(
      (id) => !restoredSourceIds.includes(id)
    );
    const nextClearedMoveIds = clearedMoveIds.filter((id) => !restoredSourceIds.includes(id));
    nextSavedFiles = sortFilesNewestFirst(nextSavedFiles);
    nextWaitSavedFiles = sortFilesNewestFirst(nextWaitSavedFiles);
    nextCompanyFiles = sortFilesNewestFirst(nextCompanyFiles);
    setMoves(nextMoves);
    setSavedFiles(nextSavedFiles);
    setWaitSavedFiles(nextWaitSavedFiles);
    setCompanyFiles(nextCompanyFiles);
    setPurgedRecycleIds(nextPurgedRecycleIds);
    setRestoredRecycleIds(nextRestoredRecycleIds);
    setClearedMoveIds(nextClearedMoveIds);
    setDeletedSourceIdsState(nextDeletedSourceIdsState);
    setRecycleBin(nextRecycleBin);
    setSelectedRecycleIds([]);
    sharedStateRef.current = {
      ...sharedStateRef.current,
      moves: nextMoves,
      savedFiles: nextSavedFiles,
      waitSavedFiles: nextWaitSavedFiles,
      companyFiles: nextCompanyFiles,
      recycleBin: nextRecycleBin,
      purgedRecycleIds: nextPurgedRecycleIds,
      restoredRecycleIds: nextRestoredRecycleIds,
      clearedMoveIds: nextClearedMoveIds,
      deletedSourceIdsState: nextDeletedSourceIdsState,
    };
    saveSharedState(sharedStateRef.current).catch(() => {
      // Keep local restore if backend save is delayed.
    });
    setNotice('Selected deleted items were restored.');
  };

  const permanentlyDeleteRecycleItems = () => {
    if (!selectedRecycleIds.length) {
      setNotice('Select one or more deleted items first.');
      return;
    }
    const nextPurgedRecycleIds = mergeStringLists(purgedRecycleIds, selectedRecycleIds);
    const nextRestoredRecycleIds = restoredRecycleIds.filter((id) => !selectedRecycleIds.includes(id));
    const nextRecycleBin = recycleBin.filter((item) => !selectedRecycleIds.includes(item.id));
    setPurgedRecycleIds(nextPurgedRecycleIds);
    setRestoredRecycleIds(nextRestoredRecycleIds);
    setRecycleBin(nextRecycleBin);
    setSelectedRecycleIds([]);
    sharedStateRef.current = {
      ...sharedStateRef.current,
      recycleBin: nextRecycleBin,
      purgedRecycleIds: nextPurgedRecycleIds,
      restoredRecycleIds: nextRestoredRecycleIds,
    };
    saveSharedState(sharedStateRef.current).catch(() => {
      // Keep local permanent delete if backend save is delayed.
    });
    setNotice('Selected deleted items were permanently deleted.');
  };

  const handleCompareFiles = () => {
    if (!selectedSavedFileIds.length) {
      setNotice('Select one or more saved files first.');
      return;
    }

    if (!selectedCompanyFileIds.length || !companyMoveNumbers.length) {
      setNotice('Select one or more company files first.');
      return;
    }

    setComparisonRequested(true);
    setNotice('Comparison complete.');
  };

  const renderOptionsContent = () => (
    <>
      <section className="options-section-card">
        <label>
          Admin Email
          <input
            value={adminNotificationEmail}
            onChange={(event) => setAdminNotificationEmail(event.target.value)}
            placeholder="Enter your email for future notifications"
          />
          <span className="field-note">
            This email is used by the local backend. Keep `npm run backend` running and set your SMTP values in `.env` for real emails.
          </span>
        </label>
      </section>

      {optionsView === 'register' ? (
        <section className="options-section-card">
          <div className="form-grid">
            <label>
              Driver Name
              <input value={newDriverName} onChange={(event) => setNewDriverName(event.target.value)} />
            </label>
            <label>
              Email
              <input value={newDriverEmail} onChange={(event) => setNewDriverEmail(event.target.value)} />
            </label>
            <label>
              Username
              <input
                value={newDriverUsername}
                onChange={(event) => setNewDriverUsername(event.target.value)}
              />
            </label>
            <label>
              Password
              <input
                value={newDriverPassword}
                onChange={(event) => setNewDriverPassword(event.target.value)}
              />
            </label>
          </div>

          <div className="inline-actions">
            <button className="secondary-btn" onClick={() => setNewDriverPassword(generatePassword())}>
              Generate
            </button>
            <button className="primary-btn" onClick={registerDriver}>
              Register
            </button>
          </div>
        </section>
      ) : (
        <div className="admin-list data-card-list">
          {accounts.filter((account) => account.role === 'driver').map((account) => (
            <div key={account.id} className="admin-list-item driver-data-card">
              {editingAccountId === account.id ? (
                <>
                  <label>
                    Driver Name
                    <input
                      value={accountDraft?.name || ''}
                      onChange={(event) =>
                        setAccountDraft((prev) => ({ ...prev, name: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Email
                    <input
                      value={accountDraft?.email || ''}
                      onChange={(event) =>
                        setAccountDraft((prev) => ({ ...prev, email: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Username
                    <input
                      value={accountDraft?.username || ''}
                      onChange={(event) =>
                        setAccountDraft((prev) => ({ ...prev, username: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Password
                    <input
                      value={accountDraft?.password || ''}
                      onChange={(event) =>
                        setAccountDraft((prev) => ({ ...prev, password: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    App Access
                    <select
                      value={accountDraft?.appBlocked ? 'blocked' : 'allowed'}
                      onChange={(event) =>
                        setAccountDraft((prev) => ({
                          ...prev,
                          appBlocked: event.target.value === 'blocked',
                        }))
                      }
                    >
                      <option value="allowed">Allowed</option>
                      <option value="blocked">Blocked</option>
                    </select>
                  </label>
                  <div className="inline-actions">
                    <button className="secondary-btn mini-btn" onClick={saveEditedAccount}>
                      Save
                    </button>
                    <button
                      className="secondary-btn mini-btn"
                      onClick={() => {
                        setEditingAccountId('');
                        setAccountDraft(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <strong>{account.name}</strong>
                  <div className="data-grid">
                    <div className="data-chip">
                      <span>Name</span>
                      <strong>{account.name}</strong>
                    </div>
                    <div className="data-chip">
                      <span>Username</span>
                      <strong>{account.username || '-'}</strong>
                    </div>
                    <div className="data-chip">
                      <span>Email</span>
                      <strong>{account.email}</strong>
                    </div>
                    <div className="data-chip">
                      <span>Password</span>
                      <strong>{account.password || '-'}</strong>
                    </div>
                    <div className={account.appBlocked ? 'data-chip access-chip blocked' : 'data-chip access-chip allowed'}>
                      <span>App Access</span>
                      <strong>{account.appBlocked ? 'Blocked' : 'Allowed'}</strong>
                    </div>
                  </div>
                  <div className="inline-actions">
                    <button
                      className="secondary-btn mini-btn data-action-btn"
                      onClick={() => startEditingAccount(account)}
                    >
                      Edit
                    </button>
                    <button
                      className="secondary-btn mini-btn data-action-btn"
                      onClick={() => resetDriverPassword(account.id)}
                    >
                      Reset Password
                    </button>
                    <button
                      className="secondary-btn mini-btn data-action-btn"
                      onClick={() => setDriverAppAccess(account.id, true)}
                    >
                      Block App
                    </button>
                    <button
                      className="secondary-btn mini-btn data-action-btn"
                      onClick={() => setDriverAppAccess(account.id, false)}
                    >
                      Allow App
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
          {!accounts.some((account) => account.role === 'driver') && (
            <div className="empty-state small-empty">No registered drivers yet.</div>
          )}
        </div>
      )}
    </>
  );

  if (!currentUser) {
    return (
      <div className="app-shell">
        <div className="auth-wrap">
          <section className="panel auth-card">
            <div className="hero-copy-block">
              <div className="brand-lockup">
                <span className="brand-badge">NX</span>
                <div className="brand-copy">
                  <h1 className="brand-title">Nexora</h1>
                  <span className="brand-subtitle">Driver App</span>
                </div>
              </div>
              <p className="notice">
                {requestedLoginFace === 'admin'
                  ? 'Admin sign in only. Use your admin username or email and password.'
                  : 'Sign in with your registered email and password to open your own driver app.'}
              </p>
            </div>

            <label>
              Email
              <input
                value={loginEmail}
                onChange={(event) => setLoginEmail(event.target.value)}
                onKeyDown={handleLoginKeyDown}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                onKeyDown={handleLoginKeyDown}
              />
            </label>
            {!!authError && <p className="notice danger-text">{authError}</p>}
            <p className={backendReady ? 'notice success-text' : 'notice danger-text'}>
              {backendReady
                ? 'Shared login service connected.'
                : 'Online login service is connecting. If this is the first login, wait one minute and try again.'}
            </p>
            {requestedLoginFace === 'admin' ? (
              <div className="notice">
                Admin login:
                <br />
                Email: <strong>{DEFAULT_ADMIN_ACCOUNT.email}</strong>
                <br />
                Username: <strong>{DEFAULT_ADMIN_ACCOUNT.username}</strong>
                <br />
                Password: <strong>{DEFAULT_ADMIN_ACCOUNT.password}</strong>
              </div>
            ) : null}
              <div className="inline-actions">
                <button className="primary-btn" onClick={handleLogin} disabled={authBusy}>
                  {authBusy ? 'Checking...' : 'Login'}
                </button>
                <button className="secondary-btn" onClick={() => openAuthDialog('forgot')}>
                  Forgot Password
                </button>
              </div>
            </section>
            {forgotPasswordOpen && (
              <div className="modal-backdrop" onClick={closeAuthDialog}>
                <div className="modal-card portal-modal" onClick={(event) => event.stopPropagation()}>
                  <button className="modal-close" onClick={closeAuthDialog}>
                    Close
                  </button>
                  <div className="panel-header">
                    <div>
                      <h2>{authDialogMode === 'change' ? 'Change Password' : 'Forgot Password'}</h2>
                      <p>
                        {authDialogMode === 'change'
                          ? 'Enter email or username, current password, and a new password.'
                          : 'Enter the registered email to request a password reset.'}
                      </p>
                    </div>
                  </div>
                  {authDialogMode === 'change' ? (
                    <>
                      <label>
                        Email Or Username
                        <input
                          value={passwordChangeIdentifier}
                          onChange={(event) => setPasswordChangeIdentifier(event.target.value)}
                          placeholder="Enter registered email or username"
                        />
                      </label>
                      <label>
                        Current Password
                        <input
                          type="password"
                          value={passwordChangeCurrent}
                          onChange={(event) => setPasswordChangeCurrent(event.target.value)}
                          placeholder="Enter current password"
                        />
                      </label>
                      <label>
                        New Password
                        <input
                          type="password"
                          value={passwordChangeNext}
                          onChange={(event) => setPasswordChangeNext(event.target.value)}
                          placeholder="Enter new password"
                        />
                      </label>
                      <div className="inline-actions">
                        <button className="primary-btn" onClick={handleChangePasswordFromLogin}>
                          Update Password
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <label>
                        Driver Email
                        <input
                          value={forgotPasswordEmail}
                          onChange={(event) => setForgotPasswordEmail(event.target.value)}
                          placeholder="Enter registered driver email"
                        />
                      </label>
                      <div className="inline-actions">
                        <button
                          className="primary-btn"
                          onClick={() => {
                            closeAuthDialog();
                            setAuthError(
                              'Password reset email will be sent from the registered driver email setup.'
                            );
                          }}
                        >
                          Send Reset Link
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }

  return (
    <div className="app-shell">
      <div className="app-layout">
        <aside className={mobileMenuOpen ? 'sidebar-card mobile-open' : 'sidebar-card'} ref={sidebarRef}>
          {isAdminUser && portalFace === 'admin' ? (
            <>
              <div className="sidebar-topbar">
                <button className="secondary-btn mini-btn" onClick={resetAdminSidebar}>
                  &larr;
                </button>
                <div className="sidebar-scroll">
                  <button className="secondary-btn mini-btn" onClick={() => scrollSidebarBy(-220)}>
                    ↑
                  </button>
                  <button className="secondary-btn mini-btn" onClick={() => scrollSidebarBy(220)}>
                    ↓
                  </button>
                </div>
              </div>

              <div className="stat-card admin-label-card">
                <span>Admin</span>
                <strong>{currentUser.name}</strong>
              </div>

              {isPhoneViewport && mobileSidebarView === 'options' ? (
                <div className="sidebar-tabs mobile-options-view">
                  <div className="sidebar-topbar mobile-options-topbar">
                    <button
                      className="secondary-btn mini-btn"
                      onClick={() => setMobileSidebarView('menu')}
                    >
                      &larr;
                    </button>
                  </div>
                  <button
                    className={optionsView === 'register' ? 'tab active' : 'tab'}
                    onClick={() => setOptionsView('register')}
                  >
                    Register
                  </button>
                  <button
                    className={optionsView === 'data' ? 'tab active' : 'tab'}
                    onClick={() => setOptionsView('data')}
                  >
                    Data
                  </button>
                  <div className="mobile-options-content">{renderOptionsContent()}</div>
                </div>
              ) : (
              <nav className="sidebar-tabs">
                <div className="portal-box-wrap">
                  <button className="tab" onClick={() => setPortalMenuOpen((prev) => !prev)}>
                    Portal
                  </button>
                  {portalMenuOpen && (
                    <div className="portal-popover">
                      <button
                        className={portalFace === 'admin' ? 'tab active mini-tab' : 'tab mini-tab'}
                        onClick={() => handlePortalFaceChange('admin')}
                      >
                        Admin Face
                      </button>
                      <button
                        className={portalFace === 'driver' ? 'tab active mini-tab' : 'tab mini-tab'}
                        onClick={() => handlePortalFaceChange('driver')}
                      >
                        Driver Face
                      </button>
                    </div>
                  )}
                </div>
                <button className="tab" onClick={() => setMovesMenuOpen((prev) => !prev)}>
                  Moves
                </button>
                {movesMenuOpen && (
                  <div className="sidebar-submenu">
                    <button
                      className={activeTab === 'capture' ? 'tab active' : 'tab'}
                      onClick={() => {
                        setActiveTab('capture');
                        setMobileMenuOpen(false);
                      }}
                    >
                      Move Capture
                    </button>
                    <button
                      className={activeTab === 'records' ? 'tab active' : 'tab'}
                      onClick={() => {
                        setActiveTab('records');
                        setMobileMenuOpen(false);
                      }}
                    >
                      Move Records
                    </button>
                    <button
                      className={activeTab === 'match' ? 'tab active' : 'tab'}
                      onClick={() => {
                        setActiveTab('match');
                        setMobileMenuOpen(false);
                      }}
                    >
                      Move Match
                    </button>
                    <button
                      className={activeTab === 'wait' ? 'tab active' : 'tab'}
                      onClick={() => {
                        setActiveTab('wait');
                        setMobileMenuOpen(false);
                      }}
                    >
                      Wait Time
                    </button>
                    <button
                      className={activeTab === 'fuel' ? 'tab active' : 'tab'}
                      onClick={() => {
                        setActiveTab('fuel');
                        setMobileMenuOpen(false);
                      }}
                    >
                      Fuel & Expenses
                    </button>
                  </div>
                )}
                <button
                  className={activeTab === 'messages' ? 'tab active' : 'tab'}
                  onClick={() => {
                    setActiveTab('messages');
                    setMobileMenuOpen(false);
                  }}
                >
                  Messages
                </button>
                  <button
                    className={mobileSidebarView === 'options' ? 'tab active' : 'tab'}
                    onClick={() => openOptionsDialogWithView('register')}
                  >
                    Options
                  </button>
                  <button
                    className={activeTab === 'recycle' ? 'tab active' : 'tab'}
                    onClick={() => {
                      setActiveTab('recycle');
                      setMobileMenuOpen(false);
                    }}
                  >
                    Recycle Bin
                  </button>
                  <button className="tab" onClick={() => openAuthDialog('change')}>
                    Change Password
                  </button>
                  <button className="secondary-btn" onClick={handleLogout}>
                    Sign Out
                  </button>
                </nav>
              )}
            </>
          ) : (
            <>
              <div className="stat-card">
                <span>Select Driver</span>
                <select
                  className="driver-select"
                  value={selectedDriver}
                  onChange={(event) => handleDriverChange(event.target.value)}
                  disabled={!isAdminUser}
                >
                  {selectableDrivers.map((driver) => (
                    <option key={driver} value={driver}>
                      {driver}
                    </option>
                  ))}
                </select>
              </div>

              <nav className="sidebar-tabs">
                {isAdminUser && (
                  <div className="portal-box-wrap">
                    <button className="tab" onClick={() => setPortalMenuOpen((prev) => !prev)}>
                      Portal
                    </button>
                    {portalMenuOpen && (
                      <div className="portal-popover">
                        <button
                          className={portalFace === 'admin' ? 'tab active mini-tab' : 'tab mini-tab'}
                          onClick={() => handlePortalFaceChange('admin')}
                        >
                          Admin Face
                        </button>
                        <button
                          className={portalFace === 'driver' ? 'tab active mini-tab' : 'tab mini-tab'}
                          onClick={() => handlePortalFaceChange('driver')}
                        >
                          Driver Face
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <button
                  className={activeTab === 'capture' ? 'tab active' : 'tab'}
                  onClick={() => {
                    setActiveTab('capture');
                    setMobileMenuOpen(false);
                  }}
                >
                  Move Capture
                </button>
                <button
                  className={activeTab === 'records' ? 'tab active' : 'tab'}
                  onClick={() => {
                    setActiveTab('records');
                    setMobileMenuOpen(false);
                  }}
                >
                  Move Records
                </button>
                <button
                  className={activeTab === 'match' ? 'tab active' : 'tab'}
                  onClick={() => {
                    setActiveTab('match');
                    setMobileMenuOpen(false);
                  }}
                >
                  Move Match
                </button>
                <button
                  className={activeTab === 'wait' ? 'tab active' : 'tab'}
                  onClick={() => {
                    setActiveTab('wait');
                    setMobileMenuOpen(false);
                  }}
                >
                  Wait Time
                </button>
                <button
                  className={activeTab === 'fuel' ? 'tab active' : 'tab'}
                  onClick={() => {
                    setActiveTab('fuel');
                    setMobileMenuOpen(false);
                  }}
                >
                  Fuel & Expenses
                </button>
                  <button
                    className={activeTab === 'messages' ? 'tab active' : 'tab'}
                    onClick={() => {
                      setActiveTab('messages');
                      setMobileMenuOpen(false);
                    }}
                  >
                    Messages
                  </button>
                  <button
                    className={activeTab === 'recycle' ? 'tab active' : 'tab'}
                    onClick={() => {
                      setActiveTab('recycle');
                      setMobileMenuOpen(false);
                    }}
                  >
                    Recycle Bin
                  </button>
                  <button className="tab" onClick={() => openAuthDialog('change')}>
                    Change Password
                  </button>
                  <button className="secondary-btn" onClick={handleLogout}>
                    Sign Out
                  </button>
                </nav>
            </>
          )}
        </aside>

        <div className="app-wrap">
        <header className="hero-card fixed-hero-card">
          <div className="hero-copy-block">
            <div className="hero-top-row">
              <button className="menu-toggle" onClick={() => setMobileMenuOpen((prev) => !prev)}>
                <span />
                <span />
                <span />
              </button>
              <h1>Driver App</h1>
            </div>
          </div>

          <div className="sidebar-stack">
            <div className="stat-card">
              <span>Date And Time</span>
              <strong className="small-stat">{clock}</strong>
            </div>
          </div>
        </header>

        {activeTab === 'capture' && (
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Move Capture Screen</h2>
                <p>
                  Choose the driver above, upload up to {MAX_SCREENSHOTS} screenshots, then click
                  save. The records table will open automatically for that driver only.
                </p>
              </div>
            </div>

            <div className="upload-card">
              <div>
                <h3>Upload Screenshots</h3>
                <p>
                  Upload up to {MAX_SCREENSHOTS} images. OCR starts automatically after upload and
                  each screenshot becomes its own move row when you save.
                </p>
                <p className="ocr-note">
                  You can still correct any value before saving or later inside the live editor.
                </p>
              </div>
              <label className="date-field">
                Entry Date
                <input
                  type="date"
                  value={form.entryDate}
                  onChange={(event) => setForm((prev) => ({ ...prev, entryDate: event.target.value }))}
                />
                <span>Leave it as today, or choose the screenshot work date.</span>
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleFilesChange}
              />
            </div>

            {!!sortedCaptureScreenshots.length && (
              <div className="shot-grid">
                {sortedCaptureScreenshots.map((shot, index) => (
                  <article key={shot.previewUrl || `${shot.name}-${index}`} className="shot-card">
                    <div className="shot-sequence-badge">#{index + 1}</div>
                    <button className="image-button" onClick={() => setSelectedImage(shot.previewUrl)}>
                      <img src={shot.previewUrl} alt={shot.name} />
                    </button>
                    <div className="shot-footer">
                      <span title={shot.name}>{shot.name}</span>
                      <div className="ocr-status-row">
                        <span
                          className={
                            shot.ocrStatus === 'done'
                              ? 'ocr-pill success'
                              : shot.ocrStatus === 'error'
                              ? 'ocr-pill error'
                              : 'ocr-pill'
                          }
                        >
                          {shot.ocrStatus === 'done'
                            ? 'Text extracted'
                            : shot.ocrStatus === 'error'
                            ? 'OCR failed'
                            : 'Reading text'}
                        </span>
                      </div>
                      <div className="ocr-preview">
                        <strong>Detected</strong>
                        <span>XAT: {shot.extracted?.xatDateTime || '-'}</span>
                        <span>Move: {shot.extracted?.moveNumber || '-'}</span>
                        <span>Origin: {shot.extracted?.origin || '-'}</span>
                        <span>Destination: {shot.extracted?.destination || '-'}</span>
                        <span>Container: {shot.extracted?.containerNumber || '-'}</span>
                        <span>Miles: {shot.extracted?.miles || '-'}</span>
                      </div>
                      <div className="shot-actions">
                        <button onClick={() => setSelectedImage(shot.previewUrl)}>View</button>
                        <button className="ghost-danger" onClick={() => removeScreenshot(shot.previewUrl)}>
                          Remove
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}

            <div className="action-bar">
              <button className="primary-btn" onClick={saveMove}>
                Save Move To Table
              </button>
              <button className="secondary-btn" onClick={() => resetForm()}>
                Clear Form
              </button>
              <span className="empty-pill">{ocrCompletedCount}/{form.screenshots.length} OCR ready</span>
              <p className="notice">{notice}</p>
            </div>
          </section>
        )}

        {activeTab === 'match' && (
          <section className="panel">
            <div className="panel-header split">
              <div>
                <h2>Move Match</h2>
                <p>
                  Save extracted move files for each driver, edit them later, then compare any
                  saved file with the company PDF.
                </p>
              </div>

              <div className="capture-summary">
                <span>Selected driver</span>
                <strong>{selectedDriver}</strong>
                <span>Selected files</span>
                <strong>{selectedSavedFileIds.length}</strong>
              </div>
            </div>

            <div className="match-grid">
              <section className="match-card">
                <div className="match-card-head">
                  <h3>Saved Files</h3>
                  <span className="empty-pill">{selectedDriverSavedFiles.length} files</span>
                </div>
                <p className="match-copy">
                  This folder stores extracted move files from screenshots for {selectedDriver}.
                  Files appear here automatically. Drivers can rename files, delete files, and
                  select multiple files for comparison.
                </p>
                <div className="save-file-bar">
                  <button
                    className="secondary-btn"
                    onClick={() => downloadMoveFilesToComputer(selectedSavedFileIds)}
                    disabled={!selectedSavedFileIds.length}
                  >
                    Save Selected To Computer
                  </button>
                  <button
                    className="secondary-btn ghost-danger"
                    onClick={deleteSelectedSavedFiles}
                    disabled={!selectedSavedFileIds.length}
                  >
                    Delete Selected
                  </button>
                </div>
                {!!moveDownloadLinks.length && (
                  <div className="download-links">
                    {moveDownloadLinks.map((download) => (
                      <a key={download.url} href={download.url} download={`${download.fileName}.xlsx`}>
                        Download {download.fileName}
                      </a>
                    ))}
                  </div>
                )}

                <div className="saved-file-list">
                  {selectedDriverSavedFiles.map((file) => (
                    <article
                      key={file.id}
                      className={selectedSavedFileIds.includes(file.id) ? 'saved-file-item active' : 'saved-file-item'}
                    >
                      <label className="saved-file-check">
                        <input
                          type="checkbox"
                          checked={selectedSavedFileIds.includes(file.id)}
                          onChange={() => {
                            setComparisonRequested(false);
                            setSelectedSavedFileIds((prev) =>
                              prev.includes(file.id)
                                ? prev.filter((id) => id !== file.id)
                                : [...prev, file.id]
                            );
                          }}
                        />
                        <span />
                      </label>

                      <div className="saved-file-main">
                        {renameFileId === file.id ? (
                          <div className="rename-row">
                            <input
                              value={renameDraft}
                              onChange={(event) => setRenameDraft(event.target.value)}
                            />
                            <button className="secondary-btn mini-btn" onClick={saveRenamedFile}>
                              Save Name
                            </button>
                          </div>
                        ) : (
                          <>
                            <strong>{file.name}</strong>
                            <span>
                              {file.rows.length} moves | updated {file.updatedAt}
                            </span>
                          </>
                        )}
                      </div>

                      <div className="file-menu-wrap">
                        <button
                          className="menu-trigger"
                          onClick={() =>
                            setOpenFileMenuId((prev) => (prev === file.id ? '' : file.id))
                          }
                        >
                          ...
                        </button>
                        {openFileMenuId === file.id && (
                          <div className="file-menu">
                            <button onClick={() => startRenameSavedFile(file)}>Rename File</button>
                            <button onClick={() => deleteSavedFile(file.id)}>Delete File</button>
                          </div>
                        )}
                      </div>
                    </article>
                  ))}

                  {!selectedDriverSavedFiles.length && (
                    <div className="empty-state small-empty">
                      No saved files yet. Save the extracted moves for this driver first.
                    </div>
                  )}
                </div>
              </section>

              <section className="match-card">
                <div className="match-card-head">
                  <h3>Company File Upload</h3>
                  <span className="empty-pill">
                    {visibleCompanyFiles.length ? `${visibleCompanyFiles.length} files` : 'No file'}
                  </span>
                </div>
                <p className="match-copy">
                  Upload company files here. Drivers can add multiple files, select them with the
                  checkbox, rename them, delete them, and compare the selected files.
                </p>
                <div className="pdf-upload-box">
                  <input
                    ref={pdfInputRef}
                    type="file"
                    accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,image/*"
                    multiple
                    onChange={handleCompanyPdfUpload}
                  />
                  <button className="primary-btn" onClick={handleCompareFiles}>
                    Compare Files
                  </button>
                </div>
                <div className="saved-file-list">
                  {visibleCompanyFiles.map((file) => (
                    <article
                      key={file.id}
                      className={
                        selectedCompanyFileIds.includes(file.id) ? 'saved-file-item active' : 'saved-file-item'
                      }
                    >
                      <label className="saved-file-check">
                        <input
                          type="checkbox"
                          checked={selectedCompanyFileIds.includes(file.id)}
                          onChange={() => {
                            setComparisonRequested(false);
                            setSelectedCompanyFileIds((prev) =>
                              prev.includes(file.id)
                                ? prev.filter((id) => id !== file.id)
                                : [...prev, file.id]
                            );
                          }}
                        />
                        <span />
                      </label>

                      <div className="saved-file-main">
                        {renameCompanyFileId === file.id ? (
                          <div className="rename-row">
                            <input
                              value={renameCompanyDraft}
                              onChange={(event) => setRenameCompanyDraft(event.target.value)}
                            />
                            <button className="secondary-btn mini-btn" onClick={saveRenamedCompanyFile}>
                              Save Name
                            </button>
                          </div>
                        ) : (
                          <>
                            <strong>{file.name}</strong>
                            <span>
                              {file.status === 'done' ? 'File ready' : 'File read failed'} | updated {file.updatedAt}
                            </span>
                          </>
                        )}
                      </div>

                      <div className="file-menu-wrap">
                        <button
                          className="menu-trigger"
                          onClick={() =>
                            setOpenCompanyMenuId((prev) => (prev === file.id ? '' : file.id))
                          }
                        >
                          ...
                        </button>
                        {openCompanyMenuId === file.id && (
                          <div className="file-menu">
                            <button onClick={() => startRenameCompanyFile(file)}>Rename File</button>
                            <button onClick={() => deleteCompanyFile(file.id)}>Delete File</button>
                          </div>
                        )}
                      </div>
                    </article>
                  ))}

                  {!visibleCompanyFiles.length && (
                    <div className="empty-state small-empty">
                      No company files uploaded yet.
                    </div>
                  )}
                </div>
              </section>
            </div>

            {!!selectedSavedFiles.length && (
              <section className="match-results">
                <div className="match-card-head">
                  <h3>{`Selected Files: ${selectedSavedFiles.map((file) => file.name).join(', ')}`}</h3>
                  <span className="empty-pill">{activeComparisonRows.length || 0} moves</span>
                </div>

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Move #</th>
                        <th>Origin</th>
                        <th>Container #</th>
                        <th>Destination</th>
                        <th>Miles</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeComparisonRows.map((move, index) => (
                        <tr key={`saved-file-row-${move.id || index}`}>
                          <td className="accent-text">{move.moveNumber}</td>
                          <td>{move.origin}</td>
                          <td>{move.containerNumber}</td>
                          <td>{move.destination}</td>
                          <td>{move.miles}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {comparisonRequested && (
            <>
            <section className="match-results same-box">
              <div className="match-card-head">
                <h3>Matched Moves In Both Files</h3>
                <span className="empty-pill">{matchedComparisonMoves.length} matched</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Move #</th>
                      <th>Origin</th>
                      <th>Container #</th>
                      <th>Destination</th>
                      <th>Miles</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matchedComparisonMoves.map((move) => (
                      <tr key={`matched-${move.id || move.moveNumber}`} className="matched-move-row">
                        <td className="accent-text">{move.moveNumber}</td>
                        <td>{move.origin}</td>
                        <td>{move.containerNumber}</td>
                        <td>{move.destination}</td>
                        <td>{move.miles}</td>
                        <td><span className="ocr-pill success">Matched</span></td>
                      </tr>
                    ))}
                    {!!companyMoveNumbers.length && !matchedComparisonMoves.length && (
                      <tr>
                        <td colSpan="6">
                          <div className="empty-state small-empty">
                            No matching moves were found between the selected files and company PDFs.
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <div className="match-grid results-grid">
              <section className="match-results">
              <div className="match-card-head">
                <h3>Extra Moves In Selected Files</h3>
                <span className="empty-pill">{screenshotExtraMoves.length} extra</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Move #</th>
                      <th>Origin</th>
                      <th>Container #</th>
                      <th>Destination</th>
                      <th>Miles</th>
                      <th>Screenshot</th>
                    </tr>
                  </thead>
                  <tbody>
                    {screenshotExtraMoves.map((move) => (
                      <tr key={`missing-${move.id}`}>
                        <td className="accent-text">{move.moveNumber}</td>
                        <td>{move.origin}</td>
                        <td>{move.containerNumber}</td>
                        <td>{move.destination}</td>
                        <td>{move.miles}</td>
                        <td>
                          <button
                            className="secondary-btn mini-btn"
                            onClick={() => setSelectedImage(move.screenshots[0].previewUrl)}
                          >
                            Open Image
                          </button>
                        </td>
                      </tr>
                    ))}
                    {!companyMoveNumbers.length && (
                      <tr>
                        <td colSpan="6">
                          <div className="empty-state small-empty">
                            Select company files to start matching moves.
                          </div>
                        </td>
                      </tr>
                    )}
                    {!!companyMoveNumbers.length && !screenshotExtraMoves.length && (
                      <tr>
                        <td colSpan="6">
                          <div className="empty-state small-empty">
                            No extra moves were found in the selected files.
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              </section>

              <section className="match-results">
                <div className="match-card-head">
                  <h3>Moves Not Available In Company PDF</h3>
                  <span className="empty-pill">{companyExtraMoves.length} short</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Move #</th>
                      </tr>
                    </thead>
                    <tbody>
                      {companyExtraMoves.map((moveNumber) => (
                        <tr key={`company-extra-${moveNumber}`}>
                          <td className="accent-text">{moveNumber}</td>
                        </tr>
                      ))}
                      {!companyMoveNumbers.length && (
                        <tr>
                          <td>
                            <div className="empty-state small-empty">
                              Select company files to start matching moves.
                            </div>
                          </td>
                        </tr>
                      )}
                      {!!companyMoveNumbers.length && !companyExtraMoves.length && (
                        <tr>
                          <td>
                            <div className="empty-state small-empty">
                              No moves are missing from the selected files.
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
            </>
            )}

            {comparisonRequested &&
              !!companyMoveNumbers.length &&
              !screenshotExtraMoves.length &&
              !companyExtraMoves.length &&
              !!activeComparisonRows.length && (
                <section className="match-results same-box">
                  <div className="empty-state">
                    Both PDFs are same.
                  </div>
                </section>
              )}
          </section>
        )}

        {activeTab === 'wait' && (
          <section className="panel">
            <div className="panel-header split">
              <div>
                <h2>Wait Time</h2>
                <p>
                  Upload screenshots that show driver, move, XAT, arrival, release, and depart
                  times. The app calculates wait time automatically using your rules.
                </p>
              </div>

              <div className="capture-summary">
                <span>Selected driver</span>
                <strong>{selectedDriver}</strong>
                <span>Wait records</span>
                <strong>{selectedDriverWaitRecords.length}</strong>
              </div>
            </div>

            <div className="upload-card">
              <div>
                <h3>Upload Wait Screenshots</h3>
                <p>
                  Upload up to {MAX_SCREENSHOTS} screenshots. OCR will detect XAT, arrival,
                  release, depart, move number, and locations.
                </p>
                <p className="ocr-note">
                  Wait time starts one hour after the later of arrival time or XAT time, then runs
                  until release time.
                </p>
              </div>
              <input
                ref={waitFileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleWaitFilesChange}
              />
            </div>

            {!!waitForm.screenshots.length && (
              <div className="shot-grid">
                {sortedWaitScreenshots.map((shot, index) => (
                  <article key={shot.previewUrl || `wait-${shot.name}-${index}`} className="shot-card">
                    <div className="shot-sequence-badge">#{index + 1}</div>
                    <button className="image-button" onClick={() => setSelectedImage(shot.previewUrl)}>
                      <img src={shot.previewUrl} alt={shot.name} />
                    </button>
                    <div className="shot-footer">
                      <span title={shot.name}>{shot.name}</span>
                      <div className="ocr-status-row">
                        <span
                          className={
                            shot.ocrStatus === 'done'
                              ? 'ocr-pill success'
                              : shot.ocrStatus === 'error'
                              ? 'ocr-pill error'
                              : 'ocr-pill'
                          }
                        >
                          {shot.ocrStatus === 'done'
                            ? 'Wait data extracted'
                            : shot.ocrStatus === 'error'
                            ? 'OCR failed'
                            : 'Reading wait data'}
                        </span>
                      </div>
                      <div className="ocr-preview">
                        <strong>Detected</strong>
                        <span>Move: {shot.extracted?.moveNumber || '-'}</span>
                        <span>Driver: {shot.extracted?.driverName || selectedDriver}</span>
                        <span>Origin: {shot.extracted?.origin || '-'}</span>
                        <span>Destination: {shot.extracted?.destination || '-'}</span>
                        <span>Container: {shot.extracted?.containerNumber || '-'}</span>
                        <span>XAT: {shot.extracted?.xatDateTime || '-'}</span>
                        <span>Arrival: {shot.extracted?.arrivalTime || '-'}</span>
                        <span>Release: {shot.extracted?.releaseTime || '-'}</span>
                        <span>Depart: {shot.extracted?.departTime || '-'}</span>
                        <span>Wait Time: {shot.extracted?.waitTime || '-'}</span>
                      </div>
                      <div className="shot-actions">
                        <button onClick={() => setSelectedImage(shot.previewUrl)}>View</button>
                        <button className="ghost-danger" onClick={() => removeWaitScreenshot(shot.previewUrl)}>
                          Remove
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}

            <div className="action-bar">
              <button className="primary-btn" onClick={saveWaitRecords}>
                Save Wait Time To Table
              </button>
              <button
                className="secondary-btn"
                onClick={() =>
                  resetWaitForm(
                    `Cleared wait-time screenshots and visible wait rows for ${selectedDriver}.`,
                    true
                  )
                }
              >
                Clear Form
              </button>
              <span className="empty-pill">
                {waitOcrCompletedCount}/{waitForm.screenshots.length} OCR ready
              </span>
              <p className="notice">{waitNotice}</p>
            </div>

            <div className="toolbar wait-toolbar">
              <input
                value={waitSearch}
                onChange={(event) => setWaitSearch(event.target.value)}
                placeholder="Search move, driver, origin, container, destination, XAT, arrival, release, depart, wait time"
              />
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Move #</th>
                    <th>Driver</th>
                    <th>Origin</th>
                    <th>Container #</th>
                    <th>Destination</th>
                    <th>XAT</th>
                    <th>Arrival</th>
                    <th>Release</th>
                    <th>Depart</th>
                    <th>Wait Time</th>
                    <th>Screenshot</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredWaitRecords.map((record) => (
                    <tr
                      key={record.id}
                      ref={(element) => {
                        if (element) {
                          waitRowRefs.current[record.id] = element;
                        }
                      }}
                    >
                      <td className="accent-text">
                        {editingWaitId === record.id ? (
                          <input
                            value={waitDraft?.moveNumber || ''}
                            onChange={(event) =>
                              setWaitDraft((prev) => ({ ...prev, moveNumber: event.target.value }))
                            }
                          />
                        ) : (
                          renderHighlightedText(record.moveNumber, waitSearch)
                        )}
                      </td>
                      <td>
                        {editingWaitId === record.id ? (
                          <select
                            value={waitDraft?.driverName || selectedDriver}
                            onChange={(event) =>
                              setWaitDraft((prev) => ({ ...prev, driverName: event.target.value }))
                            }
                          >
                            {driverOptions.map((driver) => (
                              <option key={driver} value={driver}>
                                {driver}
                              </option>
                            ))}
                          </select>
                        ) : (
                          renderHighlightedText(record.driverName, waitSearch)
                        )}
                      </td>
                      <td>
                        {editingWaitId === record.id ? (
                          <input
                            value={waitDraft?.origin || ''}
                            onChange={(event) =>
                              setWaitDraft((prev) => ({ ...prev, origin: event.target.value }))
                            }
                          />
                        ) : (
                          renderHighlightedText(record.origin, waitSearch)
                        )}
                      </td>
                      <td>
                        {editingWaitId === record.id ? (
                          <input
                            value={waitDraft?.containerNumber || ''}
                            onChange={(event) =>
                              setWaitDraft((prev) => ({ ...prev, containerNumber: event.target.value }))
                            }
                          />
                        ) : (
                          renderHighlightedText(record.containerNumber, waitSearch)
                        )}
                      </td>
                      <td>
                        {editingWaitId === record.id ? (
                          <input
                            value={waitDraft?.destination || ''}
                            onChange={(event) =>
                              setWaitDraft((prev) => ({ ...prev, destination: event.target.value }))
                            }
                          />
                        ) : (
                          renderHighlightedText(record.destination, waitSearch)
                        )}
                      </td>
                      <td>
                        {editingWaitId === record.id ? (
                          <input
                            value={waitDraft?.xatDateTime || ''}
                            onChange={(event) =>
                              setWaitDraft((prev) => ({ ...prev, xatDateTime: event.target.value }))
                            }
                          />
                        ) : (
                          renderHighlightedText(record.xatDateTime, waitSearch)
                        )}
                      </td>
                      <td>
                        {editingWaitId === record.id ? (
                          <input
                            value={waitDraft?.arrivalTime || ''}
                            onChange={(event) =>
                              setWaitDraft((prev) => ({ ...prev, arrivalTime: event.target.value }))
                            }
                          />
                        ) : (
                          renderHighlightedText(record.arrivalTime, waitSearch)
                        )}
                      </td>
                      <td>
                        {editingWaitId === record.id ? (
                          <input
                            value={waitDraft?.releaseTime || ''}
                            onChange={(event) =>
                              setWaitDraft((prev) => ({ ...prev, releaseTime: event.target.value }))
                            }
                          />
                        ) : (
                          renderHighlightedText(record.releaseTime, waitSearch)
                        )}
                      </td>
                      <td>
                        {editingWaitId === record.id ? (
                          <input
                            value={waitDraft?.departTime || ''}
                            onChange={(event) =>
                              setWaitDraft((prev) => ({ ...prev, departTime: event.target.value }))
                            }
                          />
                        ) : (
                          renderHighlightedText(record.departTime, waitSearch)
                        )}
                      </td>
                      <td className="accent-text">{renderHighlightedText(record.waitTime, waitSearch)}</td>
                      <td>
                        {record.screenshots?.length ? (
                          <button
                            className="secondary-btn mini-btn"
                            onClick={() => setSelectedImage(record.screenshots[0].previewUrl)}
                          >
                            Open Image
                          </button>
                        ) : (
                          <span className="empty-pill">No image</span>
                        )}
                      </td>
                      <td>
                        {isAdminUser && editingWaitId === record.id ? (
                          <div className="inline-actions">
                            <button className="secondary-btn mini-btn" onClick={saveEditedWaitRecord}>
                              Save
                            </button>
                            <button
                              className="secondary-btn mini-btn"
                              onClick={() => {
                                setEditingWaitId('');
                                setWaitDraft(null);
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : isAdminUser ? (
                          <button className="secondary-btn mini-btn" onClick={() => startEditingWaitRecord(record)}>
                            Edit
                          </button>
                        ) : (
                          <span className="empty-pill">View only</span>
                        )}
                      </td>
                    </tr>
                  ))}

                  {!filteredWaitRecords.length && (
                    <tr>
                      <td colSpan="12">
                        <div className="empty-state small-empty">No wait records matched your search.</div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <section className="match-results">
              <div className="match-card-head">
                <h3>Wait Time Saved Files</h3>
                <span className="empty-pill">{selectedDriverWaitSavedFiles.length} files</span>
              </div>
              <p className="match-copy">
                Extracted wait-time files appear here automatically after review. Drivers can
                select multiple files, rename them, delete them, and save them to the computer.
              </p>
              <div className="save-file-bar">
                <button
                  className="secondary-btn"
                  onClick={() => downloadWaitFilesToComputer(selectedWaitSavedFileIds)}
                >
                  Save Selected To Computer
                </button>
                <button className="secondary-btn ghost-danger" onClick={deleteSelectedWaitFiles}>
                  Delete Selected
                </button>
              </div>
              {!!waitDownloadLinks.length && (
                <div className="download-links">
                  {waitDownloadLinks.map((download) => (
                    <a key={download.url} href={download.url} download={`${download.fileName}.xlsx`}>
                      Download {download.fileName}
                    </a>
                  ))}
                </div>
              )}

              <div className="saved-file-list">
                {selectedDriverWaitSavedFiles.map((file) => (
                  <article
                    key={file.id}
                    className={
                      selectedWaitSavedFileIds.includes(file.id) ? 'saved-file-item active' : 'saved-file-item'
                    }
                  >
                    <label className="saved-file-check">
                      <input
                        type="checkbox"
                        checked={selectedWaitSavedFileIds.includes(file.id)}
                        onChange={() =>
                          setSelectedWaitSavedFileIds((prev) =>
                            prev.includes(file.id)
                              ? prev.filter((id) => id !== file.id)
                              : [...prev, file.id]
                          )
                        }
                      />
                      <span />
                    </label>

                    <div className="saved-file-main">
                      {renameWaitFileId === file.id ? (
                        <div className="rename-row">
                          <input
                            value={renameWaitDraft}
                            onChange={(event) => setRenameWaitDraft(event.target.value)}
                          />
                          <button className="secondary-btn mini-btn" onClick={saveRenamedWaitFile}>
                            Save Name
                          </button>
                        </div>
                      ) : (
                        <>
                          <strong>{file.name}</strong>
                          <span>
                            {file.rows.length} rows | updated {file.updatedAt}
                          </span>
                        </>
                      )}
                    </div>

                    <div className="file-menu-wrap">
                      <button
                        className="menu-trigger"
                        onClick={() =>
                          setOpenWaitFileMenuId((prev) => (prev === file.id ? '' : file.id))
                        }
                      >
                        ...
                      </button>
                      {openWaitFileMenuId === file.id && (
                        <div className="file-menu">
                          <button onClick={() => startRenameWaitFile(file)}>Rename File</button>
                          <button onClick={() => deleteWaitFile(file.id)}>Delete File</button>
                        </div>
                      )}
                    </div>
                  </article>
                ))}

                {!selectedDriverWaitSavedFiles.length && (
                  <div className="empty-state small-empty">
                    No wait time saved files yet. Save wait time records first.
                  </div>
                )}
              </div>
            </section>
          </section>
        )}

        {activeTab === 'fuel' && (
          <section className="panel">
            <div className="panel-header split">
              <div>
                <h2>Fuel & Expenses</h2>
                <p>
                  Track live weather, daily miles, fuel receipts, truck expenses, and two-week
                  paycheck comparisons for {selectedDriver}.
                </p>
              </div>
              <div className="capture-summary">
                <span>Live weather</span>
                <strong>
                  {weatherInfo ? `${Math.round(weatherInfo.temperature_2m)}°C` : 'Waiting'}
                </strong>
                <span>{weatherInfo ? `Wind ${Math.round(weatherInfo.wind_speed_10m)} km/h` : weatherNotice}</span>
              </div>
            </div>

            <div className="match-grid finance-grid">
              <section className="match-card">
                <div className="match-card-head">
                  <h3>Fuel Tracking</h3>
                  <span className="empty-pill">{selectedFuelRecords.length} entries</span>
                </div>
                <div className="form-grid compact-form">
                  <label>
                    Fuel Date
                    <input
                      type="date"
                      value={fuelForm.entryDate}
                      onChange={(event) => setFuelForm((prev) => ({ ...prev, entryDate: event.target.value }))}
                    />
                  </label>
                  <label>
                    Current KM
                    <input
                      value={fuelForm.km}
                      onChange={(event) => setFuelForm((prev) => ({ ...prev, km: event.target.value }))}
                      placeholder="Truck KM"
                    />
                  </label>
                  <label>
                    Fuel Quantity
                    <input
                      value={fuelForm.fuelQuantity}
                      onChange={(event) => setFuelForm((prev) => ({ ...prev, fuelQuantity: event.target.value }))}
                      placeholder="Litres or gallons"
                    />
                  </label>
                  <label>
                    Fuel Total
                    <input
                      value={fuelForm.fuelCost}
                      onChange={(event) => setFuelForm((prev) => ({ ...prev, fuelCost: event.target.value }))}
                      placeholder="Receipt total"
                    />
                  </label>
                  <label>
                    Station
                    <input
                      value={fuelForm.station}
                      onChange={(event) => setFuelForm((prev) => ({ ...prev, station: event.target.value }))}
                      placeholder="Fuel station"
                    />
                  </label>
                  <label>
                    Receipt Upload
                    <input type="file" accept="image/*" onChange={handleFuelReceiptUpload} />
                  </label>
                </div>
                <div className="action-bar">
                  <button className="primary-btn" onClick={saveFuelRecord}>
                    Save Fuel Entry
                  </button>
                  <span className="notice">{fuelNotice}</span>
                </div>
                <div className="summary-strip">
                  <span>Total fuel: <strong>{fuelSummary.totalFuel.toFixed(2)}</strong></span>
                  <span>Total cost: <strong>${fuelSummary.totalCost.toFixed(2)}</strong></span>
                  <span>KM tracked: <strong>{Math.round(fuelSummary.kmDriven)}</strong></span>
                  <span>Next fill estimate: <strong>{fuelSummary.nextFillKm ? `${Math.round(fuelSummary.nextFillKm)} KM` : '-'}</strong></span>
                </div>
                <div className="table-wrap mini-table">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>KM</th>
                        <th>Fuel</th>
                        <th>Total</th>
                        <th>Station</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedFuelRecords.map((record) => (
                        <tr key={record.id}>
                          <td>{record.entryDate}</td>
                          <td>{record.km}</td>
                          <td>{record.fuelQuantity}</td>
                          <td>{record.fuelCost}</td>
                          <td>{record.station}</td>
                        </tr>
                      ))}
                      {!selectedFuelRecords.length && (
                        <tr><td colSpan="5"><div className="empty-state small-empty">No fuel entries yet.</div></td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="match-card">
                <div className="match-card-head">
                  <h3>Truck Expenses</h3>
                  <span className="empty-pill">Year total ${yearlyExpenseTotal.toFixed(2)}</span>
                </div>
                <div className="form-grid compact-form">
                  <label>
                    Date
                    <input
                      type="date"
                      value={expenseForm.entryDate}
                      onChange={(event) => setExpenseForm((prev) => ({ ...prev, entryDate: event.target.value }))}
                    />
                  </label>
                  <label>
                    Category
                    <input
                      value={expenseForm.category}
                      onChange={(event) => setExpenseForm((prev) => ({ ...prev, category: event.target.value }))}
                    />
                  </label>
                  <label>
                    Vendor
                    <input
                      value={expenseForm.vendor}
                      onChange={(event) => setExpenseForm((prev) => ({ ...prev, vendor: event.target.value }))}
                    />
                  </label>
                  <label>
                    Total
                    <input
                      value={expenseForm.total}
                      onChange={(event) => setExpenseForm((prev) => ({ ...prev, total: event.target.value }))}
                    />
                  </label>
                  <label>
                    Receipt Upload
                    <input type="file" accept="image/*" onChange={handleExpenseReceiptUpload} />
                  </label>
                </div>
                <div className="action-bar">
                  <button className="primary-btn" onClick={saveExpenseRecord}>
                    Save Expense
                  </button>
                  <span className="notice">{expenseNotice}</span>
                </div>
                <div className="table-wrap mini-table">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Category</th>
                        <th>Vendor</th>
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedExpenseRecords.map((record) => (
                        <tr key={record.id}>
                          <td>{record.entryDate}</td>
                          <td>{record.category}</td>
                          <td>{record.vendor}</td>
                          <td>{record.total}</td>
                        </tr>
                      ))}
                      {!selectedExpenseRecords.length && (
                        <tr><td colSpan="4"><div className="empty-state small-empty">No expenses yet.</div></td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            <section className="match-card full-width-card">
              <div className="match-card-head">
                <h3>Daily Miles & Two-Week Paycheck</h3>
                <span className="empty-pill">{dailyMiles.length} driving days</span>
              </div>
              <div className="form-grid compact-form">
                <label>
                  Start Date
                  <input
                    type="date"
                    value={paycheckForm.startDate}
                    onChange={(event) => setPaycheckForm((prev) => ({ ...prev, startDate: event.target.value }))}
                  />
                </label>
                <label>
                  End Date
                  <input
                    type="date"
                    value={paycheckForm.endDate}
                    onChange={(event) => setPaycheckForm((prev) => ({ ...prev, endDate: event.target.value }))}
                  />
                </label>
                <label>
                  Paycheck Amount
                  <input
                    value={paycheckForm.paycheckAmount}
                    onChange={(event) => setPaycheckForm((prev) => ({ ...prev, paycheckAmount: event.target.value }))}
                    placeholder="Check amount"
                  />
                </label>
              </div>
              <div className="action-bar">
                <button className="primary-btn" onClick={savePaycheckRecord}>
                  Save Paycheck Comparison
                </button>
              </div>
              <div className="table-wrap mini-table">
                <table>
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Miles</th>
                      <th>Paycheck</th>
                      <th>Pay / Mile</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paycheckComparisons.map((record) => (
                      <tr key={record.id}>
                        <td>{record.startDate} to {record.endDate}</td>
                        <td>{record.miles.toFixed(1)}</td>
                        <td>{record.paycheckAmount}</td>
                        <td>{record.payPerMile ? `$${record.payPerMile.toFixed(2)}` : '-'}</td>
                      </tr>
                    ))}
                    {!paycheckComparisons.length && (
                      <tr><td colSpan="4"><div className="empty-state small-empty">No paycheck comparisons saved yet.</div></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="summary-strip">
                {dailyMiles.slice(-14).map((day) => (
                  <span key={day.date}>{day.date}: <strong>{day.miles.toFixed(1)} miles</strong></span>
                ))}
              </div>
            </section>
          </section>
        )}

        {activeTab === 'messages' && (
          <section className="panel">
            <div className="panel-header split">
              <div>
                <h2>Messages</h2>
                <p>
                  {isAdminUser && portalFace === 'admin'
                    ? 'Admin can search every driver message and keep the full local history.'
                    : 'Driver messages show only the latest 100 messages in this local app.'}
                </p>
              </div>

              <div className="capture-summary">
                <span>Current User</span>
                <strong>{currentUser.name}</strong>
                <span>Messages showing</span>
                <strong>{selectedMessages.length}</strong>
              </div>
            </div>

            <div className="toolbar">
              <input
                value={messageSearch}
                onChange={(event) => setMessageSearch(event.target.value)}
                placeholder={
                  isAdminUser && portalFace === 'admin'
                    ? 'Search driver, sender, or message'
                    : 'Search your messages'
                }
              />
            </div>

            {isAdminUser && portalFace === 'admin' && (
              <section className="inline-driver-list">
                <div className="panel-header split">
                  <div>
                    <h3>Driver List</h3>
                    <p>Search drivers, select one or many, then press OK to open those messages.</p>
                  </div>
                  <span className="empty-pill">{selectedMessageDriverNames.length} selected</span>
                </div>

                <div className="toolbar">
                  <input
                    value={driverListSearch}
                    onChange={(event) => setDriverListSearch(event.target.value)}
                    placeholder="Search driver name, email, or username"
                  />
                  <div className="inline-actions">
                    <button
                      className="secondary-btn"
                      onClick={() =>
                        setSelectedMessageDriverNames(
                          filteredMessageDriverAccounts.map((account) => account.name)
                        )
                      }
                    >
                      Select All
                    </button>
                    <button className="secondary-btn" onClick={() => setSelectedMessageDriverNames([])}>
                      Clear
                    </button>
                    <button className="primary-btn" onClick={confirmDriverMessageSelection}>
                      OK
                    </button>
                  </div>
                </div>

                <div className="driver-list-grid">
                  {filteredMessageDriverAccounts.map((account) => (
                    <label key={account.id} className="driver-list-item">
                      <input
                        type="checkbox"
                        checked={selectedMessageDriverNames.includes(account.name)}
                        onChange={() => toggleMessageDriverSelection(account.name)}
                      />
                      <div>
                        <strong>{account.name}</strong>
                        <span>{account.email}</span>
                        <span>Username: {account.username || '-'}</span>
                      </div>
                    </label>
                  ))}

                  {!filteredMessageDriverAccounts.length && (
                    <div className="empty-state small-empty">No drivers matched your search.</div>
                  )}
                </div>
              </section>
            )}

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Driver</th>
                    <th>Sender</th>
                    <th>Message</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedMessages.map((message) => (
                    <tr key={message.id}>
                      <td>{message.driverName}</td>
                      <td>{message.senderName}</td>
                      <td>{message.body}</td>
                      <td>{message.createdAt}</td>
                    </tr>
                  ))}
                  {!selectedMessages.length && (
                    <tr>
                      <td colSpan="4">
                        <div className="empty-state small-empty">No messages yet.</div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="action-bar">
              <input
                value={messageDraft}
                onChange={(event) => setMessageDraft(event.target.value)}
                placeholder={
                  isAdminUser && portalFace === 'admin'
                    ? `Send message to ${selectedDriver}`
                    : 'Send message to admin'
                }
              />
              <button className="primary-btn" onClick={sendMessage}>
                Send Message
              </button>
            </div>
          </section>
        )}

        {activeTab === 'records' && (
          <section className="panel">
            <div className="panel-header split">
              <div>
                <h2>Move Records Table</h2>
                <p>
                  Showing only moves for {selectedDriver}. Click the screenshot button to open the
                  move image, then use Edit to update any move live.
                </p>
              </div>

              <div className="capture-summary">
                <span>Selected driver</span>
                <strong>{selectedDriver}</strong>
                <span>Moves showing</span>
                <strong>{filteredMoves.length}</strong>
              </div>
            </div>

            <div className="toolbar">
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search move number, driver, origin, container, destination, miles"
              />
              <div className="toolbar-actions">
                <button className="secondary-btn" onClick={saveRecordsToSavedFiles}>
                  Save To Files Folder
                </button>
                <button
                  className="secondary-btn ghost-danger"
                  onClick={clearSelectedDriverRecords}
                  disabled={!filteredMoves.length}
                >
                  Clear Data
                </button>
              </div>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Move #</th>
                    <th>Driver Name</th>
                    <th>Origin</th>
                    <th>Container #</th>
                    <th>Destination</th>
                    <th>Miles</th>
                    <th>Screenshot</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMoves.map((move) => (
                    <tr
                      key={move.id}
                      ref={(element) => {
                        if (element) {
                          recordRowRefs.current[move.id] = element;
                        }
                      }}
                    >
                      <td className="accent-text">
                        {editingMoveId === move.id ? (
                          <input
                            value={moveDraft?.moveNumber || ''}
                            onChange={(event) =>
                              setMoveDraft((prev) => ({ ...prev, moveNumber: event.target.value }))
                            }
                          />
                        ) : (
                          renderHighlightedText(move.moveNumber, search)
                        )}
                      </td>
                      <td>
                        {editingMoveId === move.id ? (
                          <select
                            value={moveDraft?.driverName || selectedDriver}
                            onChange={(event) =>
                              setMoveDraft((prev) => ({ ...prev, driverName: event.target.value }))
                            }
                          >
                            {driverOptions.map((driver) => (
                              <option key={driver} value={driver}>
                                {driver}
                              </option>
                            ))}
                          </select>
                        ) : (
                          renderHighlightedText(move.driverName, search)
                        )}
                      </td>
                      <td>
                        {editingMoveId === move.id ? (
                          <input
                            value={moveDraft?.origin || ''}
                            onChange={(event) =>
                              setMoveDraft((prev) => ({ ...prev, origin: event.target.value }))
                            }
                          />
                        ) : (
                          renderHighlightedText(move.origin, search)
                        )}
                      </td>
                      <td>
                        {editingMoveId === move.id ? (
                          <input
                            value={moveDraft?.containerNumber || ''}
                            onChange={(event) =>
                              setMoveDraft((prev) => ({ ...prev, containerNumber: event.target.value }))
                            }
                          />
                        ) : (
                          renderHighlightedText(move.containerNumber, search)
                        )}
                      </td>
                      <td>
                        {editingMoveId === move.id ? (
                          <input
                            value={moveDraft?.destination || ''}
                            onChange={(event) =>
                              setMoveDraft((prev) => ({ ...prev, destination: event.target.value }))
                            }
                          />
                        ) : (
                          renderHighlightedText(move.destination, search)
                        )}
                      </td>
                      <td>
                        {editingMoveId === move.id ? (
                          <input
                            value={moveDraft?.miles || ''}
                            onChange={(event) =>
                              setMoveDraft((prev) => ({ ...prev, miles: event.target.value }))
                            }
                          />
                        ) : (
                          renderHighlightedText(move.miles, search)
                        )}
                      </td>
                      <td>
                        {move.screenshots?.length ? (
                          <button
                            className="secondary-btn mini-btn"
                            onClick={() => setSelectedImage(move.screenshots[0].previewUrl)}
                          >
                            Open Image
                          </button>
                        ) : (
                          <span className="empty-pill">No image</span>
                        )}
                      </td>
                      <td>
                        {isAdminUser && editingMoveId === move.id ? (
                          <div className="inline-actions">
                            <button className="secondary-btn mini-btn" onClick={saveEditedMove}>
                              Save
                            </button>
                            <button
                              className="secondary-btn mini-btn"
                              onClick={() => {
                                setEditingMoveId('');
                                setMoveDraft(null);
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : isAdminUser ? (
                          <div className="inline-actions">
                            <button className="secondary-btn mini-btn" onClick={() => startEditingMove(move)}>
                              Edit
                            </button>
                            <button
                              className="secondary-btn mini-btn ghost-danger"
                              onClick={() => deleteMoveRecord(move.id)}
                            >
                              Delete
                            </button>
                          </div>
                        ) : (
                          <button
                            className="secondary-btn mini-btn ghost-danger"
                            onClick={() => deleteMoveRecord(move.id)}
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}

                  {!filteredMoves.length && (
                    <tr>
                      <td colSpan="8">
                        <div className="empty-state small-empty">No move records matched your search.</div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {activeTab === 'recycle' && (
          <section className="panel recycle-panel">
            <div className="recycle-bin-dialog">
              <div className="panel-header">
                <div className="recycle-header">
                  <div>
                    <h2>Recycle Bin</h2>
                    <p>
                      Deleted screenshots and files appear here automatically. Driver view keeps items for
                      14 days. Admin view keeps all deleted items for 30 days.
                    </p>
                  </div>
                  <div className="capture-summary recycle-summary">
                    <span>Deleted items</span>
                    <strong>{visibleRecycleBin.length}</strong>
                  </div>
                </div>
              </div>
              <div className="recycle-bin-wrap">
                <div className="save-file-bar recycle-actions">
                  <button
                    className="secondary-btn"
                    onClick={() =>
                      setSelectedRecycleIds(
                        selectedRecycleIds.length === visibleRecycleBin.length
                          ? []
                          : visibleRecycleBin.map((item) => item.id)
                      )
                    }
                  >
                    {selectedRecycleIds.length === visibleRecycleBin.length && visibleRecycleBin.length
                      ? 'Clear Selection'
                      : 'Select All'}
                  </button>
                  <button
                    className="secondary-btn"
                    onClick={restoreRecycleItems}
                    disabled={!selectedRecycleIds.length}
                  >
                    Revert Selected
                  </button>
                  <button
                    className="secondary-btn ghost-danger"
                    onClick={permanentlyDeleteRecycleItems}
                    disabled={!selectedRecycleIds.length}
                  >
                    Delete Selected
                  </button>
                </div>
                <div className="saved-file-list">
                  {visibleRecycleBin.map((item) => (
                    <article
                      key={item.id}
                      className={selectedRecycleIds.includes(item.id) ? 'saved-file-item active' : 'saved-file-item'}
                    >
                      <label className="saved-file-check">
                        <input
                          type="checkbox"
                          checked={selectedRecycleIds.includes(item.id)}
                          onChange={() =>
                            setSelectedRecycleIds((prev) =>
                              prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]
                            )
                          }
                        />
                        <span />
                      </label>
                      <div className="saved-file-main">
                        <strong>{item.name}</strong>
                        <span>
                          {item.type}
                          {item.driverName ? ` | ${item.driverName}` : ''}
                          {item.deletedAt ? ` | deleted ${item.deletedAt}` : ''}
                        </span>
                      </div>
                      {item.previewUrl ? (
                        <button className="secondary-btn mini-btn" onClick={() => setSelectedImage(item.previewUrl)}>
                          Open Image
                        </button>
                      ) : null}
                    </article>
                  ))}
                  {!visibleRecycleBin.length && (
                    <div className="empty-state small-empty">No deleted items yet.</div>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
      </div>

      {selectedImage && (
        <div className="modal-backdrop" onClick={() => setSelectedImage(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelectedImage(null)}>
              Close
            </button>
            <img src={selectedImage} alt="Selected screenshot preview" className="modal-image" />
          </div>
        </div>
      )}

        {forgotPasswordOpen && (
          <div className="modal-backdrop" onClick={closeAuthDialog}>
            <div className="modal-card portal-modal" onClick={(event) => event.stopPropagation()}>
              <button className="modal-close" onClick={closeAuthDialog}>
                Close
              </button>
              <div className="panel-header">
                <div>
                  <h2>{authDialogMode === 'change' ? 'Change Password' : 'Forgot Password'}</h2>
                  <p>
                    {authDialogMode === 'change'
                      ? 'Enter email or username, current password, and a new password.'
                      : 'Enter the registered email to request a password reset.'}
                  </p>
                </div>
              </div>
              {authDialogMode === 'change' ? (
                <>
                  <label>
                    Email Or Username
                    <input
                      value={passwordChangeIdentifier}
                      onChange={(event) => setPasswordChangeIdentifier(event.target.value)}
                      placeholder="Enter registered email or username"
                    />
                  </label>
                  <label>
                    Current Password
                    <input
                      type="password"
                      value={passwordChangeCurrent}
                      onChange={(event) => setPasswordChangeCurrent(event.target.value)}
                      placeholder="Enter current password"
                    />
                  </label>
                  <label>
                    New Password
                    <input
                      type="password"
                      value={passwordChangeNext}
                      onChange={(event) => setPasswordChangeNext(event.target.value)}
                      placeholder="Enter new password"
                    />
                  </label>
                  <div className="inline-actions">
                    <button
                      className="primary-btn"
                      onClick={handleChangePasswordFromLogin}
                      disabled={authBusy}
                    >
                      {authBusy ? 'Updating...' : 'Update Password'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <label>
                    Driver Email
                    <input
                      value={forgotPasswordEmail}
                      onChange={(event) => setForgotPasswordEmail(event.target.value)}
                      placeholder="Enter registered driver email"
                    />
                  </label>
                  <div className="inline-actions">
                    <button
                      className="primary-btn"
                      onClick={() => {
                        closeAuthDialog();
                        setAuthError(
                          'Password reset email will be sent from the registered driver email setup.'
                        );
                      }}
                    >
                      Send Reset Link
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {optionsDialogOpen && (
        <div className="modal-backdrop" onClick={() => setOptionsDialogOpen(false)}>
          <div className="modal-card options-modal" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setOptionsDialogOpen(false)}>
              Close
            </button>
            <div className="panel-header">
              <div>
                <h2>Options</h2>
                <p>Register drivers, update saved driver data, and set your admin email.</p>
              </div>
            </div>

            <div className="inline-actions">
              <button
                className={optionsView === 'register' ? 'tab active mini-tab' : 'tab mini-tab'}
                onClick={() => setOptionsView('register')}
              >
                Register
              </button>
              <button
                className={optionsView === 'data' ? 'tab active mini-tab' : 'tab mini-tab'}
                onClick={() => setOptionsView('data')}
              >
                Data
              </button>
            </div>
            {renderOptionsContent()}
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
