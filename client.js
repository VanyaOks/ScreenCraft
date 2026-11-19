/**
 * Browser half of the screenshot annotator bundle.
 *
 * Adds one compact button to the composer tool row. The button opens a
 * full-window editor where a screenshot is pasted or dropped, marked with
 * numbered colored points, rectangles, and arrows, and given a comment per
 * marker. On "Вставить в чат" the annotated PNG is downscaled for token
 * economy, saved into the Session workspace by the Host half, and a compact
 * marker legend is inserted into the composer together with the file path.
 *
 * The editor is deliberately client-only: it never touches another plugin's
 * DOM, never replaces a shipped slot, and never uploads the screenshot to a
 * third party. Only the same-origin Host route receives the finished PNG.
 */

window.__ModuleLoader__.load({
  id: 'dsh-screenshot-annotator',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NAMESPACE = 'screenshotAnnotator';
    const SAVE_ROUTE = '/screenshot-annotator/save';
    const TOKEN_DIVISOR = 750;
    const MAX_COMMENT = 400;
    const EDITOR_VERSION = '0.6.0';

    /* ------------------------------------------------------------------ */
    /* Shared state                                                        */
    /* ------------------------------------------------------------------ */

    const store = (() => {
      let open = false;
      let sessionId;
      let version = 0;
      let snapshot = { open, sessionId, version };
      const listeners = new Set();
      let insertHandler;

      const publish = (nextOpen, nextSession) => {
        open = nextOpen;
        sessionId = nextSession;
        version += 1;
        snapshot = { open, sessionId, version };
        for (const listener of [...listeners]) listener();
      };

      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getSnapshot() {
          return snapshot;
        },
        open(id) {
          publish(true, id);
        },
        close() {
          publish(false, sessionId);
        },
        setInsertHandler(handler) {
          insertHandler = handler;
          return () => {
            if (insertHandler === handler) insertHandler = undefined;
          };
        },
        async insert(text) {
          if (insertHandler === undefined) return false;
          try {
            const result = await insertHandler(text);
            return result !== false;
          } catch {
            return false;
          }
        },
      };
    })();

    /** React 18 `useSyncExternalStore` with a small compatibility fallback. */
    const useStoreState = typeof React.useSyncExternalStore === 'function'
      ? () => React.useSyncExternalStore(store.subscribe, store.getSnapshot)
      : () => {
        const [value, setValue] = React.useState(store.getSnapshot);
        React.useEffect(() => store.subscribe(() => setValue(store.getSnapshot())), []);
        return value;
      };

    /* ------------------------------------------------------------------ */
    /* Markers                                                             */
    /* ------------------------------------------------------------------ */

    const MARKER_COLORS = Object.freeze([
      { id: 'red', value: '#e53935', text: '#ffffff' },
      { id: 'orange', value: '#fb8c00', text: '#ffffff' },
      { id: 'yellow', value: '#fdd835', text: '#1b1b1b' },
      { id: 'green', value: '#43a047', text: '#ffffff' },
      { id: 'cyan', value: '#00acc1', text: '#ffffff' },
      { id: 'blue', value: '#1e88e5', text: '#ffffff' },
      { id: 'purple', value: '#8e24aa', text: '#ffffff' },
      { id: 'pink', value: '#d81b60', text: '#ffffff' },
    ]);

    /** Color → purpose preset. Choosing a purpose also chooses its color. */
    const MEANING_BY_COLOR = Object.freeze({
      red: 'meaningError',
      yellow: 'meaningFix',
      green: 'meaningOk',
      blue: 'meaningQuestion',
      orange: 'meaningImportant',
      purple: 'meaningIdea',
      cyan: 'meaningNote',
      pink: 'meaningRelation',
    });

    const meaningKeyFor = (colorId) => MEANING_BY_COLOR[colorId] ?? undefined;

    const MARKER_KINDS = Object.freeze(['move', 'point', 'rect', 'arrow', 'ruler']);

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    /** Photoshop-like ruler snapping: 10° steps while Shift is held. */
    const SNAP_ANGLE_STEP = Math.PI / 18;

    function snapAnglePoint(start, point, step = SNAP_ANGLE_STEP) {
      const dx = point.x - start.x;
      const dy = point.y - start.y;
      const length = Math.hypot(dx, dy);
      if (length === 0) return point;
      const angle = Math.round(Math.atan2(dy, dx) / step) * step;
      return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
    }

    /** Export formats the editor can save. */
    const EXPORT_FORMATS = Object.freeze({
      png: { mime: 'image/png', ext: 'png', label: 'PNG' },
      jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG' },
      webp: { mime: 'image/webp', ext: 'webp', label: 'WebP' },
    });

    /** Quadratic control point for a curved arrow (`curve` is -1…1). */
    function arrowControlPoint(marker) {
      const dx = marker.x2 - marker.x1;
      const dy = marker.y2 - marker.y1;
      const length = Math.hypot(dx, dy) || 1;
      const offset = length * 0.5 * (marker.curve ?? 0);
      return {
        x: (marker.x1 + marker.x2) / 2 - (dy / length) * offset,
        y: (marker.y1 + marker.y2) / 2 + (dx / length) * offset,
      };
    }

    function quadraticPoint(start, control, end, t) {
      const mt = 1 - t;
      return {
        x: mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x,
        y: mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y,
      };
    }

    function distanceToSegment(point, start, end) {
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSq = dx * dx + dy * dy;
      const ratio = lengthSq === 0 ? 0 : clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq, 0, 1);
      return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
    }

    /** Direction of an arrow at its head. */
    function arrowHeadAngle(marker, control) {
      return Math.atan2(marker.y2 - control.y, marker.x2 - control.x);
    }

    /** Preferred anchor of a marker's number badge. */
    function badgeBase(marker, radius) {
      if (marker.kind === 'point') return { x: marker.x1, y: marker.y1 };
      if (marker.kind === 'rect') {
        return { x: Math.min(marker.x1, marker.x2), y: Math.min(marker.y1, marker.y2) };
      }
      if (marker.kind === 'ruler') {
        const dx = marker.x2 - marker.x1;
        const dy = marker.y2 - marker.y1;
        const length = Math.hypot(dx, dy) || 1;
        return {
          x: (marker.x1 + marker.x2) / 2 - (dy / length) * radius * 1.5,
          y: (marker.y1 + marker.y2) / 2 + (dx / length) * radius * 1.5,
        };
      }
      const control = arrowControlPoint(marker);
      const angle = arrowHeadAngle(marker, control);
      return {
        x: marker.x2 + Math.cos(angle + Math.PI / 2) * radius * 1.25,
        y: marker.y2 + Math.sin(angle + Math.PI / 2) * radius * 1.25,
      };
    }

    /** Spread number badges so they do not overlap each other. */
    function computeBadgePositions(markers, image, radius) {
      const positions = new Map();
      const placed = [];
      const spacing = radius * 2.3;
      for (const marker of markers) {
        const base = badgeBase(marker, radius);
        let best = base;
        let bestOverlap = Infinity;
        for (let ring = 0; ring < 4; ring += 1) {
          const distance = ring === 0 ? 0 : radius * 1.9 * ring;
          const steps = ring === 0 ? 1 : 10;
          for (let step = 0; step < steps; step += 1) {
            const angle = (step / steps) * Math.PI * 2;
            const candidate = {
              x: clamp(base.x + Math.cos(angle) * distance, radius, image.width - radius),
              y: clamp(base.y + Math.sin(angle) * distance, radius, image.height - radius),
            };
            let overlap = 0;
            for (const other of placed) {
              const distanceToOther = Math.hypot(candidate.x - other.x, candidate.y - other.y);
              if (distanceToOther < spacing) overlap += spacing - distanceToOther;
            }
            if (overlap < bestOverlap) {
              bestOverlap = overlap;
              best = candidate;
            }
            if (overlap === 0) break;
          }
          if (bestOverlap === 0) break;
        }
        positions.set(marker.id, best);
        placed.push(best);
      }
      return positions;
    }

    /** SHA-256 of the pasted file, used as the annotation storage key. */
    async function hashFile(file) {
      try {
        const buffer = await file.arrayBuffer();
        if (globalThis.crypto?.subtle === undefined) return undefined;
        const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
        return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      } catch {
        return undefined;
      }
    }

    const STORAGE_KEY = 'screenCraft.annotations.v1';
    const STORAGE_LIMIT = 80;

    function readAnnotationStorage() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const parsed = raw === null ? {} : JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    function writeAnnotationStorage(map) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
      } catch {
        // Storage can be full or disabled; persistence is best effort.
      }
    }

    const colorById = (id) => MARKER_COLORS.find((color) => color.id === id) ?? MARKER_COLORS[0];

    const percent = (value, total) => Math.round((value / total) * 100);

    /** Marker label used in the legend text. */
    const kindKey = (kind) => {
      if (kind === 'rect') return 'kindRect';
      if (kind === 'arrow') return 'kindArrow';
      if (kind === 'ruler') return 'kindRuler';
      return 'kindPoint';
    };

    /** Coordinate phrase for one marker, in percent of the image size. */
    function markerCoordinates(marker, width, height) {
      if (marker.kind === 'rock') return '';
      if (marker.kind === 'point') {
        return `${percent(marker.x1, width)}%,${percent(marker.y1, height)}%`;
      }
      if (marker.kind === 'rect') {
        const left = percent(Math.min(marker.x1, marker.x2), width);
        const right = percent(Math.max(marker.x1, marker.x2), width);
        const top = percent(Math.min(marker.y1, marker.y2), height);
        const bottom = percent(Math.max(marker.y1, marker.y2), height);
        return `${left}–${right}% × ${top}–${bottom}%`;
      }
      return `${percent(marker.x1, width)},${percent(marker.y1, height)}% → `
        + `${percent(marker.x2, width)},${percent(marker.y2, height)}%`;
    }

    /** Convert a marker to another shape, keeping a sensible anchor point. */
    function convertMarkerShape(marker, kind, image) {
      if (marker.kind === kind) return marker;
      const stepX = image.width * 0.08;
      const stepY = image.height * 0.08;
      if (kind === 'point') {
        return { ...marker, kind, x1: marker.x2, y1: marker.y2, x2: marker.x2, y2: marker.y2 };
      }
      if (kind === 'rect') {
        if (marker.kind === 'point') {
          return { ...marker, kind, x2: Math.min(image.width, marker.x1 + stepX), y2: Math.min(image.height, marker.y1 + stepY) };
        }
        return {
          ...marker,
          kind,
          x1: Math.min(marker.x1, marker.x2),
          y1: Math.min(marker.y1, marker.y2),
          x2: Math.max(marker.x1, marker.x2),
          y2: Math.max(marker.y1, marker.y2),
        };
      }
      if (marker.kind === 'point') {
        return { ...marker, kind, x2: Math.min(image.width, marker.x1 + stepX), y2: Math.min(image.height, marker.y1 + stepY) };
      }
      return {
        ...marker,
        kind,
        x1: Math.min(marker.x1, marker.x2),
        y1: Math.min(marker.y1, marker.y2),
        x2: Math.max(marker.x1, marker.x2),
        y2: Math.max(marker.y1, marker.y2),
      };
    }

    /**
     * Give every marker group a sequential number in order of first appearance.
     * Deleting a marker therefore closes the gap instead of leaving a hole in the
     * numbering; all shapes of one group share the same number.
     */
    function renumberMarkers(markers) {
      const numbers = new Map();
      let next = 0;
      for (const marker of markers) {
        if (!numbers.has(marker.groupId)) {
          next += 1;
          numbers.set(marker.groupId, next);
        }
      }
      return markers.map((marker) => {
        const number = numbers.get(marker.groupId);
        return marker.no === number ? marker : { ...marker, no: number };
      });
    }

    /** Split the flat marker list into groups, preserving order. */
    function groupMarkers(markers) {
      const groups = [];
      const byId = new Map();
      for (const marker of markers) {
        let group = byId.get(marker.groupId);
        if (group === undefined) {
          group = { id: marker.groupId, markers: [] };
          byId.set(marker.groupId, group);
          groups.push(group);
        }
        group.markers.push(marker);
      }
      return groups;
    }

    /* ------------------------------------------------------------------ */
    /* Locale                                                              */
    /* ------------------------------------------------------------------ */

    const RU = {
      annotateButton: 'Аннотировать скриншот',
      title: 'ScreenCraft',
      subtitle: 'Вставьте скриншот, поставьте метки и добавьте комментарии — картинка и расшифровка меток уйдут в чат вместе. Правая кнопка мыши — тип и цвет метки.',
      pasteHint: 'Нажмите Ctrl+V, чтобы вставить скриншот',
      dropHint: 'или перетащите файл сюда',
      chooseFile: 'Выбрать файл',
      replaceImage: 'Заменить изображение',
      toolMove: 'Перемещение',
      toolPoint: 'Точка',
      toolRect: 'Прямоугольник',
      toolArrow: 'Стрелка',
      toolRuler: 'Линейка',
      toolCrop: 'Обрезать',
      toolRedact: 'Скрыть',
      format: 'Формат',
      textOnly: 'Только текст',
      batchAdd: 'В очередь',
      batchCount: 'В очереди: {n}',
      batchClear: 'Очистить',
      batchAdded: 'Добавлено в очередь: {n}. Вставьте следующий скриншот или нажмите «Вставить в чат».',
      annotationsRestored: 'Аннотации восстановлены',
      legendTextOnly: 'Только текст, без изображения (координаты — % от ширины×высоты):',
      legendBatch: 'Скриншоты с метками ({n}):',
      itemText: 'без изображения',
      styleLine: 'Линия',
      styleSolid: 'Обычная',
      styleDashed: 'Пунктир',
      styleHeads: 'Наконечники',
      styleOneHead: 'Один',
      styleTwoHeads: 'Два',
      styleWeight: 'Толщина',
      styleThin: 'Тонкая',
      styleNormal: 'Обычная',
      styleThick: 'Толстая',
      styleShape: 'Форма',
      styleStraight: 'Прямая',
      styleCurved: 'Дуга',
      redactDone: 'Область скрыта (пикселизация)',
      merge: 'Объединить ({n})',
      ungroup: 'Разъединить',
      deleteGroup: 'Удалить группу',
      groupShapes: 'Фигур: {n}',
      groupHint: 'Отметьте несколько меток и объедините их под один комментарий',
      ctxNewMarker: 'Новая метка',
      ctxMarker: 'Метка',
      ctxType: 'Тип',
      ctxColor: 'Цвет',
      ctxMeaning: 'Назначение',
      meaningError: 'ошибка',
      meaningFix: 'поправить',
      meaningOk: 'так и надо',
      meaningQuestion: 'вопрос',
      meaningImportant: 'важно',
      meaningIdea: 'идея',
      meaningNote: 'пояснение',
      meaningRelation: 'связь',
      cropConfirm: 'Обрезать изображение и сбросить метки?',
      autoTrimNotice: 'Пустые поля обрезаны: {w}×{h}',
      croppedNotice: 'Изображение обрезано: {w}×{h}',
      restoredNotice: 'Восстановлено изображение до обрезки',
      restore: 'Вернуть',
      undo: 'Отменить',
      redo: 'Повторить',
      zoomOut: 'Уменьшить',
      zoomIn: 'Увеличить',
      fit: 'Вписать',
      collapse: 'Свернуть',
      expand: 'Развернуть',
      quality: 'Размер для модели',
      qMax: 'Максимум экономии',
      qEconomy: 'Экономия',
      qDetail: 'Детали',
      qOriginal: 'Оригинал',
      tokenEstimate: '≈ {count} токенов на картинку',
      markers: 'Метки',
      noMarkers: 'Меток пока нет. Выберите инструмент и щёлкните по скриншоту.',
      commentPlaceholder: 'Комментарий к метке',
      deleteMarker: 'Удалить метку',
      close: 'Закрыть',
      save: 'Скачать PNG',
      download: 'Скачать PNG',
      insert: 'Вставить в чат',
      working: 'Сохраняю…',
      saved: 'Вставлено в поле ввода — проверьте текст и отправьте.',
      insertFailed: 'Не удалось вставить текст в поле ввода автоматически. Текст скопирован в буфер, картинка скачана — прикрепите PNG вручную и вставьте текст (Ctrl+V).',
      saveFailed: 'Не удалось сохранить картинку в рабочую папку. Файл скачан, текст скопирован — прикрепите PNG вручную и вставьте текст (Ctrl+V).',
      closeConfirm: 'Закрыть редактор без вставки в чат?',
      legendPreview: 'Текст, который уйдёт вместе с картинкой',
      showLegend: 'Показать текст',
      hideLegend: 'Скрыть текст',
      kindPoint: 'точка',
      kindRect: 'прямоугольник',
      kindArrow: 'стрелка',
      kindRuler: 'линейка',
      colorRed: 'красный',
      colorOrange: 'оранжевый',
      colorYellow: 'жёлтый',
      colorGreen: 'зелёный',
      colorCyan: 'голубой',
      colorBlue: 'синий',
      colorPurple: 'фиолетовый',
      colorPink: 'розовый',
      legendWithPath: 'Скриншот с метками: {path} ({w}×{h}) — прочитай изображение через read_image.',
      legendWithoutPath: 'Скриншот с метками прикреплён вручную ({w}×{h}) — прочитай изображение через read_image.',
      legendCoords: 'Метки (координаты — % от ширины×высоты):',
      legendNoMarkers: 'Меток нет.',
      onlyImages: 'Можно вставить только изображение.',
      imageReplaced: 'Скриншот заменён, метки сброшены.',
      copied: 'Текст скопирован в буфер обмена.',
      errorPrefix: 'Ошибка: ',
    };

    const EN = {
      annotateButton: 'Annotate screenshot',
      title: 'ScreenCraft',
      subtitle: 'Paste a screenshot, add markers and comments — the image and its marker legend go to the chat together. Right-click sets the marker type and color.',
      pasteHint: 'Press Ctrl+V to paste a screenshot',
      dropHint: 'or drop a file here',
      chooseFile: 'Choose file',
      replaceImage: 'Replace image',
      toolMove: 'Move',
      toolPoint: 'Point',
      toolRect: 'Rectangle',
      toolArrow: 'Arrow',
      toolRuler: 'Ruler',
      toolCrop: 'Crop',
      toolRedact: 'Hide',
      format: 'Format',
      textOnly: 'Text only',
      batchAdd: 'Add to queue',
      batchCount: 'Queued: {n}',
      batchClear: 'Clear',
      batchAdded: 'Added to the queue: {n}. Paste the next screenshot or press Insert into chat.',
      annotationsRestored: 'Annotations restored',
      legendTextOnly: 'Text only, no image (coordinates are % of width×height):',
      legendBatch: 'Annotated screenshots ({n}):',
      itemText: 'no image',
      styleLine: 'Line',
      styleSolid: 'Solid',
      styleDashed: 'Dashed',
      styleHeads: 'Heads',
      styleOneHead: 'One',
      styleTwoHeads: 'Two',
      styleWeight: 'Weight',
      styleThin: 'Thin',
      styleNormal: 'Normal',
      styleThick: 'Thick',
      styleShape: 'Shape',
      styleStraight: 'Straight',
      styleCurved: 'Curved',
      redactDone: 'Area hidden (pixelated)',
      merge: 'Merge ({n})',
      ungroup: 'Ungroup',
      deleteGroup: 'Delete group',
      groupShapes: 'Shapes: {n}',
      groupHint: 'Select several markers and merge them under one comment',
      ctxNewMarker: 'New marker',
      ctxMarker: 'Marker',
      ctxType: 'Type',
      ctxColor: 'Color',
      ctxMeaning: 'Purpose',
      meaningError: 'error',
      meaningFix: 'fix',
      meaningOk: 'as intended',
      meaningQuestion: 'question',
      meaningImportant: 'important',
      meaningIdea: 'idea',
      meaningNote: 'note',
      meaningRelation: 'relation',
      cropConfirm: 'Crop the image and reset markers?',
      autoTrimNotice: 'Empty margins cropped: {w}×{h}',
      croppedNotice: 'Image cropped: {w}×{h}',
      restoredNotice: 'Restored the image from before the crop',
      restore: 'Restore',
      undo: 'Undo',
      redo: 'Redo',
      zoomOut: 'Zoom out',
      zoomIn: 'Zoom in',
      fit: 'Fit',
      collapse: 'Collapse',
      expand: 'Expand',
      quality: 'Size for the model',
      qMax: 'Maximum savings',
      qEconomy: 'Savings',
      qDetail: 'Details',
      qOriginal: 'Original',
      tokenEstimate: '≈ {count} tokens per image',
      markers: 'Markers',
      noMarkers: 'No markers yet. Pick a tool and click the screenshot.',
      commentPlaceholder: 'Marker comment',
      deleteMarker: 'Delete marker',
      close: 'Close',
      save: 'Download PNG',
      download: 'Download PNG',
      insert: 'Insert into chat',
      working: 'Saving…',
      saved: 'Inserted into the composer — review the text and send it.',
      insertFailed: 'The text could not be inserted automatically. It is copied to the clipboard and the image was downloaded — attach the PNG manually and paste the text (Ctrl+V).',
      saveFailed: 'The image could not be saved into the workspace. The file was downloaded and the text copied — attach the PNG manually and paste the text (Ctrl+V).',
      closeConfirm: 'Close the editor without inserting into the chat?',
      legendPreview: 'Text that goes together with the image',
      showLegend: 'Show text',
      hideLegend: 'Hide text',
      kindPoint: 'point',
      kindRect: 'rectangle',
      kindArrow: 'arrow',
      kindRuler: 'ruler',
      colorRed: 'red',
      colorOrange: 'orange',
      colorYellow: 'yellow',
      colorGreen: 'green',
      colorCyan: 'cyan',
      colorBlue: 'blue',
      colorPurple: 'purple',
      colorPink: 'pink',
      legendWithPath: 'Annotated screenshot: {path} ({w}×{h}) — read the image with read_image.',
      legendWithoutPath: 'Annotated screenshot attached manually ({w}×{h}) — read the image with read_image.',
      legendCoords: 'Markers (coordinates are % of width×height):',
      legendNoMarkers: 'No markers.',
      onlyImages: 'Only images can be inserted.',
      imageReplaced: 'Screenshot replaced, markers cleared.',
      copied: 'Text copied to the clipboard.',
      errorPrefix: 'Error: ',
    };

    const COLOR_KEYS = Object.freeze({
      red: 'colorRed', orange: 'colorOrange', yellow: 'colorYellow', green: 'colorGreen',
      cyan: 'colorCyan', blue: 'colorBlue', purple: 'colorPurple', pink: 'colorPink',
    });

    /* ------------------------------------------------------------------ */
    /* Icons and styles                                                    */
    /* ------------------------------------------------------------------ */

    function Icon({ name, size = 16 }) {
      const paths =
        name === 'move' ? [
          [h('path', { key: 'm', d: 'M4 3l7 17 2.2-6.8L20 11z' })],
        ] : name === 'point' ? [
          [h('circle', { key: 'c', cx: 12, cy: 12, r: 6.5, fill: 'currentColor', stroke: 'none' })],
        ] : name === 'rect' ? [
          [h('rect', { key: 'r', x: 4, y: 6, width: 16, height: 12, rx: 2 })],
        ] : name === 'arrow' ? [
          [h('path', { key: 'l', d: 'M4 19L19 5' }), h('path', { key: 'a', d: 'M12 5h7v7' })],
        ] : name === 'ruler' ? [
          [h('path', { key: 'l', d: 'M4 20L20 6' }), h('path', { key: 'a', d: 'M4 20l-1.5-1.5M20 6l1.5 1.5' }), h('path', { key: 'b', d: 'M8 16l-1.5-1.5M12 12l-1.5-1.5M16 8l-1.5-1.5' })],
        ] : name === 'redact' ? [
          [h('rect', { key: 'r', x: 4, y: 6, width: 16, height: 12, rx: 2 }), h('path', { key: 'p', d: 'M8 11h.01M12 11h.01M16 11h.01M8 14h.01M12 14h.01M16 14h.01' })],
        ] : name === 'crop' ? [
          [h('path', { key: 'a', d: 'M7 3v14h14' }), h('path', { key: 'b', d: 'M3 7h14v14' })],
        ] : name === 'undo' ? [
          [h('path', { key: 'p', d: 'M9 7L4 11l5 4' }), h('path', { key: 'q', d: 'M4 11h9a6 6 0 010 12' })],
        ] : name === 'redo' ? [
          [h('path', { key: 'p', d: 'M15 7l5 4-5 4' }), h('path', { key: 'q', d: 'M20 11h-9a6 6 0 000 12' })],
        ] : name === 'trash' ? [
          [h('path', { key: 'p', d: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13' })],
        ] : name === 'close' ? [
          [h('path', { key: 'p', d: 'M6 6l12 12M18 6L6 18' })],
        ] : name === 'download' ? [
          [h('path', { key: 'p', d: 'M12 4v11M7 11l5 5 5-5M5 20h14' })],
        ] : name === 'check' ? [
          [h('path', { key: 'p', d: 'M5 12l5 5L20 6' })],
        ] : name === 'image' ? [
          [h('rect', { key: 'r', x: 3, y: 4, width: 18, height: 16, rx: 3 }), h('path', { key: 'p', d: 'M3 16l5-5 4 4 3-3 6 6' })],
        ] : [
          [h('circle', { key: 'c', cx: 12, cy: 12, r: 8 })],
        ];
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, paths[0]);
    }

    const CSS = `
.sa-annotate-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.16));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#b9bdc8);cursor:pointer;transition:background .12s,color .12s}
.sa-annotate-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f2f4f8)}
.sa-annotate-btn:active{transform:scale(.96)}
.sa-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(6,8,13,.74);backdrop-filter:blur(7px);font-family:var(--dsw-font-ui,system-ui,-apple-system,"Segoe UI",sans-serif);color:var(--dsw-alias-label-primary,#e8eaf0)}
.sa-panel{display:flex;flex-direction:column;width:min(1440px,97vw);height:min(940px,96vh);overflow:hidden;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));border-radius:16px;background:var(--dsw-alias-bg-layer-1,#12141a);box-shadow:0 28px 90px rgba(0,0,0,.6)}
.sa-head{display:flex;align-items:flex-start;gap:12px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1))}
.sa-head h2{margin:0;font-size:15px;font-weight:650;letter-spacing:.1px}
.sa-head p{margin:3px 0 0;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-secondary,#9aa1af);max-width:760px}
.sa-head .sa-close{margin-left:8px}
.sa-version{margin-left:auto;align-self:flex-start;font-size:10px;line-height:19px;color:var(--dsw-alias-label-secondary,#8b93a3);opacity:.75;user-select:none}
.sa-ctx{position:fixed;z-index:2147483001;display:flex;flex-direction:column;gap:8px;min-width:230px;max-width:270px;max-height:min(86vh,640px);overflow:auto;padding:10px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.16));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#171a21);box-shadow:0 16px 44px rgba(0,0,0,.55)}
.sa-ctx-title{font-size:12px;font-weight:650;color:var(--dsw-alias-label-primary,#e8eaf0)}
.sa-ctx-label{font-size:10px;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#8b93a3)}
.sa-ctx-row{display:flex;gap:6px}
.sa-ctx-item{display:inline-flex;flex:1 1 0;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 6px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#e8eaf0);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.sa-ctx-item:hover{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08))}
.sa-ctx-item.sa-active{border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.24));background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.12))}
.sa-ctx-colors{flex-wrap:wrap;padding-top:2px}
.sa-ctx-presets{flex-wrap:wrap}
.sa-ctx-preset{display:inline-flex;flex:1 1 44%;align-items:center;gap:6px;height:26px;padding:0 6px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#e8eaf0);font:inherit;font-size:11px;cursor:pointer;min-width:0}
.sa-ctx-preset:hover{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08))}
.sa-ctx-preset.sa-active{border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.24));background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.12))}
.sa-preset-dot{flex:0 0 auto;width:12px;height:12px;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(255,255,255,.35)}
.sa-preset-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sa-meaning-label{margin-left:5px;font-size:11px;line-height:1;color:var(--dsw-alias-label-secondary,#9aa1af);white-space:nowrap}
.sa-ctx-types{flex-wrap:wrap}
.sa-ctx-types .sa-ctx-item{flex:1 1 44%;min-width:0}
.sa-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 11px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.16));border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#e8eaf0);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.sa-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08))}
.sa-btn:disabled{opacity:.45;cursor:default}
.sa-btn.sa-primary{background:var(--dsw-alias-accent,#4d6bfe);border-color:transparent;color:#fff;font-weight:600}
.sa-btn.sa-primary:hover{background:var(--dsw-alias-accent-hover,#637ffe)}
.sa-btn.sa-icon{width:30px;padding:0}
.sa-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:9px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.03))}
.sa-group{display:inline-flex;align-items:center;gap:4px;padding-right:10px;border-right:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1))}
.sa-group:last-child{border-right:0;padding-right:0}
.sa-tool{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#a8afbd);cursor:pointer;padding:0}
.sa-tool:hover{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f2f4f8)}
.sa-tool.sa-active{border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.2));background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.12));color:var(--dsw-alias-label-primary,#fff)}
.sa-swatches{display:inline-flex;align-items:center;gap:5px}
.sa-swatch{width:18px;height:18px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0;outline:none}
.sa-swatch.sa-active{border-color:#fff;box-shadow:0 0 0 2px rgba(0,0,0,.45)}
.sa-toolbar label{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa1af)}
.sa-toolbar select{height:28px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.16));border-radius:7px;background:var(--dsw-alias-bg-layer-1,#12141a);color:var(--dsw-alias-label-primary,#e8eaf0);font:inherit;font-size:12px}
.sa-zoom{font-size:12px;min-width:42px;text-align:center;color:var(--dsw-alias-label-secondary,#9aa1af)}
.sa-body{display:flex;flex:1;min-height:0}
.sa-main{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0}
.sa-stage{flex:1;min-height:0;overflow:auto;padding:16px;background:radial-gradient(circle at 30% 20%,rgba(255,255,255,.045),transparent 60%),#0b0d12}
.sa-stage-inner{position:relative;margin:0 auto}
.sa-stage img{display:block;width:100%;height:auto;user-select:none;-webkit-user-drag:none;border-radius:4px;box-shadow:0 8px 30px rgba(0,0,0,.45)}
.sa-svg{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:crosshair;overflow:visible}
.sa-svg.sa-move{cursor:default}
.sa-side{display:flex;flex-direction:column;width:320px;min-width:260px;border-left:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));background:var(--dsw-alias-bg-layer-1,#12141a)}
.sa-body.sa-landscape{flex-direction:column}
.sa-side.sa-side-below{width:auto;min-width:0;max-height:min(48%,320px);border-left:0;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));flex:0 0 auto}
.sa-side.sa-side-below .sa-marker-list{display:flex;flex-wrap:nowrap;gap:8px;overflow-x:auto;overflow-y:auto;padding:8px 12px;flex:0 1 auto}
.sa-side.sa-side-below .sa-empty{margin:0;padding:10px 12px}
.sa-side.sa-side-below .sa-marker{flex:0 0 auto;width:300px}
.sa-side.sa-side-below .sa-marker textarea{min-height:38px;max-height:58px}
.sa-side.sa-side-below .sa-legend{border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));padding:6px 12px;flex:0 0 auto}
.sa-side.sa-side-below .sa-legend pre{max-height:56px}
.sa-side.sa-side-below.sa-collapsed{max-height:44px}
.sa-side.sa-side-below.sa-collapsed .sa-marker-list,.sa-side.sa-side-below.sa-collapsed .sa-empty,.sa-side.sa-side-below.sa-collapsed .sa-legend,.sa-side.sa-side-below.sa-collapsed .sa-group-hint{display:none}
.sa-side.sa-side-below.sa-collapsed .sa-side-head{border-bottom:0}
.sa-btn-small{height:24px;padding:0 8px;font-size:11px;margin-left:8px}
.sa-fit{font-size:14px}
.sa-stage-landscape{padding:8px 12px}
.sa-side-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#9aa1af)}
.sa-count{margin-left:auto;font-weight:600;color:var(--dsw-alias-label-primary,#e8eaf0)}
.sa-marker-list{flex:1;min-height:0;overflow:auto;padding:8px}
.sa-marker{display:flex;gap:8px;padding:8px;border:1px solid transparent;border-radius:9px}
.sa-marker.sa-selected{border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.2));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05))}
.sa-badge{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:20px;height:20px;margin-top:2px;border-radius:50%;font-size:11px;font-weight:700;color:#fff}
.sa-marker-body{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.sa-marker-meta{font-size:11px;line-height:1.3;color:var(--dsw-alias-label-secondary,#9aa1af)}
.sa-marker textarea{min-height:44px;max-height:120px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));border-radius:7px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));color:var(--dsw-alias-label-primary,#e8eaf0);font:inherit;font-size:12px;line-height:1.4;resize:vertical}
.sa-marker textarea:focus{outline:none;border-color:var(--dsw-alias-accent,#4d6bfe)}
.sa-delete{flex:0 0 auto;align-self:flex-start;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa1af);cursor:pointer}
.sa-delete:hover{background:rgba(229,57,53,.16);color:#ef5350}
.sa-group-chips{display:flex;flex-wrap:wrap;gap:4px}
.sa-chip{display:inline-flex;align-items:center;gap:3px;max-width:100%;padding:1px 4px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));font-size:10px;color:var(--dsw-alias-label-secondary,#9aa1af)}
.sa-chip input{width:11px;height:11px;margin:0;accent-color:var(--dsw-alias-accent,#4d6bfe)}
.sa-chip-label{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:0}
.sa-chip-label:hover{color:var(--dsw-alias-label-primary,#e8eaf0)}
.sa-chip-del{border:0;background:transparent;color:inherit;cursor:pointer;padding:0 1px;font-size:12px;line-height:1}
.sa-chip-del:hover{color:#ef5350}
.sa-group-actions{display:flex;gap:6px;margin-top:2px}
.sa-merge{margin-left:6px}
.sa-group-hint{padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary,#9aa1af)}
.sa-empty{margin:18px 12px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#9aa1af)}
.sa-legend{border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));padding:10px 12px}
.sa-legend summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa1af);list-style:none}
.sa-legend summary::-webkit-details-marker{display:none}
.sa-legend pre{margin:8px 0 0;max-height:160px;overflow:auto;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));font:11px/1.5 ui-monospace,Consolas,"Cascadia Mono",monospace;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,#dfe3ea)}
.sa-foot{display:flex;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.03));flex-wrap:wrap}
.sa-foot-field{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa1af)}
.sa-foot-field select{height:26px;padding:0 5px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.16));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#12141a);color:var(--dsw-alias-label-primary,#e8eaf0);font:inherit;font-size:11px}
.sa-foot-check{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa1af);cursor:pointer;white-space:nowrap}
.sa-foot-check input{width:12px;height:12px;margin:0;accent-color:var(--dsw-alias-accent,#4d6bfe)}
.sa-foot-info{font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary,#9aa1af)}
.sa-notice{flex:1;min-width:0;font-size:12px;line-height:1.4;color:#f2b84b;overflow:hidden;text-overflow:ellipsis}
.sa-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.sa-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;margin:22px;padding:40px;border:1.5px dashed var(--dsw-alias-border-l1,rgba(255,255,255,.24));border-radius:16px;color:var(--dsw-alias-label-secondary,#9aa1af);text-align:center}
.sa-drop strong{font-size:14px;color:var(--dsw-alias-label-primary,#e8eaf0)}
.sa-drop span{font-size:12px}
.sa-hidden{display:none}
`;

    /* ------------------------------------------------------------------ */
    /* Rendering helpers                                                   */
    /* ------------------------------------------------------------------ */

    function badgeRadiusFor(image) {
      return Math.max(10, Math.min(36, image.width * 0.016));
    }

    function drawBadge(target, x, y, radius, color, label) {
      target.save();
      target.beginPath();
      target.arc(x, y, radius, 0, Math.PI * 2);
      target.fillStyle = color.value;
      target.fill();
      target.lineWidth = Math.max(2, radius * 0.18);
      target.strokeStyle = 'rgba(255,255,255,0.96)';
      target.stroke();
      target.lineWidth = Math.max(1, radius * 0.08);
      target.strokeStyle = 'rgba(0,0,0,0.35)';
      target.stroke();
      target.fillStyle = color.text;
      target.font = `700 ${Math.round(radius * 1.32)}px "Segoe UI", Arial, sans-serif`;
      target.textAlign = 'center';
      target.textBaseline = 'middle';
      target.fillText(label, x, y + radius * 0.06);
      target.restore();
    }

    function strokeWithHalo(target, drawPath, color, width, dashed) {
      target.save();
      target.lineCap = 'round';
      target.lineJoin = 'round';
      target.setLineDash(dashed === true ? [width * 3.2, width * 2.4] : []);
      drawPath();
      target.globalAlpha = 0.9;
      target.lineWidth = width * 2.6;
      target.strokeStyle = 'rgba(255,255,255,0.92)';
      target.stroke();
      target.globalAlpha = 1;
      target.lineWidth = width;
      target.strokeStyle = color.value;
      target.stroke();
      target.restore();
    }

    function drawArrowHead(target, x, y, angle, size, color, lineWidth) {
      target.save();
      target.beginPath();
      target.moveTo(x, y);
      target.lineTo(x - size * Math.cos(angle - Math.PI / 7), y - size * Math.sin(angle - Math.PI / 7));
      target.lineTo(x - size * Math.cos(angle + Math.PI / 7), y - size * Math.sin(angle + Math.PI / 7));
      target.closePath();
      target.fillStyle = color.value;
      target.fill();
      target.strokeStyle = 'rgba(255,255,255,0.92)';
      target.lineWidth = Math.max(1.5, lineWidth * 0.9);
      target.stroke();
      target.restore();
    }

    /** Draw one marker into a canvas at the exported scale. */
    function drawMarker(target, marker, image, outWidth, badgePosition) {
      const scale = outWidth / image.width;
      const color = colorById(marker.color);
      const radius = badgeRadiusFor(image) * scale;
      const weight = marker.weight === 1 ? 0.7 : marker.weight === 3 ? 1.5 : 1;
      const lineWidth = Math.max(1.5, outWidth * 0.0026 * weight);
      const dashed = marker.dashed === true;
      const canvasHeight = image.height * scale;
      const sx = (value) => value * scale;
      const drawBadgeAt = () => {
        const position = badgePosition ?? badgeBase(marker, badgeRadiusFor(image));
        drawBadge(
          target,
          clamp(position.x * scale, radius, outWidth - radius),
          clamp(position.y * scale, radius, canvasHeight - radius),
          radius,
          color,
          String(marker.no),
        );
      };
      if (marker.kind === 'point') {
        drawBadgeAt();
        return;
      }
      if (marker.kind === 'rect') {
        const left = Math.min(sx(marker.x1), sx(marker.x2));
        const top = Math.min(sx(marker.y1), sx(marker.y2));
        const width = Math.abs(sx(marker.x2) - sx(marker.x1));
        const height = Math.abs(sx(marker.y2) - sx(marker.y1));
        target.save();
        target.globalAlpha = 0.16;
        target.fillStyle = color.value;
        target.fillRect(left, top, width, height);
        target.restore();
        strokeWithHalo(target, () => target.strokeRect(left, top, width, height), color, lineWidth, dashed);
        drawBadgeAt();
        return;
      }
      if (marker.kind === 'ruler') {
        const x1 = sx(marker.x1);
        const y1 = sx(marker.y1);
        const x2 = sx(marker.x2);
        const y2 = sx(marker.y2);
        strokeWithHalo(target, () => {
          target.beginPath();
          target.moveTo(x1, y1);
          target.lineTo(x2, y2);
        }, color, lineWidth, dashed);
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const tick = Math.max(10, radius * 0.9);
        const tickX = -Math.sin(angle) * tick;
        const tickY = Math.cos(angle) * tick;
        strokeWithHalo(target, () => {
          target.beginPath();
          target.moveTo(x1 - tickX, y1 - tickY);
          target.lineTo(x1 + tickX, y1 + tickY);
          target.moveTo(x2 - tickX, y2 - tickY);
          target.lineTo(x2 + tickX, y2 + tickY);
        }, color, lineWidth, dashed);
        drawBadgeAt();
        return;
      }
      const start = { x: sx(marker.x1), y: sx(marker.y1) };
      const end = { x: sx(marker.x2), y: sx(marker.y2) };
      const controlNatural = arrowControlPoint(marker);
      const control = { x: controlNatural.x * scale, y: controlNatural.y * scale };
      const curved = (marker.curve ?? 0) !== 0;
      strokeWithHalo(target, () => {
        target.beginPath();
        target.moveTo(start.x, start.y);
        if (curved) target.quadraticCurveTo(control.x, control.y, end.x, end.y);
        else target.lineTo(end.x, end.y);
      }, color, lineWidth, dashed);
      const angle = Math.atan2(end.y - control.y, end.x - control.x);
      const headSize = Math.max(10, radius * 1.15);
      drawArrowHead(target, end.x, end.y, angle, headSize, color, lineWidth);
      if (marker.doubleHead === true) {
        const startAngle = curved ? Math.atan2(start.y - control.y, start.x - control.x) : angle + Math.PI;
        drawArrowHead(target, start.x, start.y, startAngle, headSize, color, lineWidth);
      }
      drawBadgeAt();
    }

    /** Render the annotated image and return its data URL and pixel size. */
    function renderExport(image, markers, longEdge, format = 'png') {
      const scale = longEdge > 0 ? Math.min(1, longEdge / Math.max(image.width, image.height)) : 1;
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const target = canvas.getContext('2d');
      if (target === null) throw new Error('canvas 2d context is unavailable');
      if (format === 'jpeg') {
        target.fillStyle = '#ffffff';
        target.fillRect(0, 0, width, height);
      }
      target.drawImage(image.element, 0, 0, width, height);
      const badgePositions = computeBadgePositions(markers, image, badgeRadiusFor(image));
      for (const marker of markers) drawMarker(target, marker, image, width, badgePositions.get(marker.id));
      const meta = EXPORT_FORMATS[format] ?? EXPORT_FORMATS.png;
      return {
        dataUrl: canvas.toDataURL(meta.mime, format === 'png' ? undefined : 0.9),
        width,
        height,
        mime: meta.mime,
        ext: meta.ext,
      };
    }

    /** Estimated image tokens for the chosen export size. */
    function estimateTokens(image, longEdge) {
      const scale = longEdge > 0 ? Math.min(1, longEdge / Math.max(image.width, image.height)) : 1;
      const width = Math.round(image.width * scale);
      const height = Math.round(image.height * scale);
      return Math.max(1, Math.round((width * height) / TOKEN_DIVISOR));
    }

    /** Draw a cropped region of an image into a canvas and return a data URL. */
    function cropToDataUrl(element, rect) {
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const target = canvas.getContext('2d');
      if (target === null) throw new Error('canvas 2d context is unavailable');
      target.drawImage(element, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
      return { dataUrl: canvas.toDataURL('image/png'), width, height };
    }

    /** Load a data URL into an image element. */
    function loadImageElement(dataUrl) {
      return new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('image decode failed'));
        element.src = dataUrl;
      });
    }

    /**
     * Detect the content rectangle of a screenshot.
     *
     * Screenshots frequently carry large margins that are not part of the window
     * being captured: a desktop wallpaper, an empty canvas, a gradient backdrop.
     * Those margins are smooth and have no contrast edges, while real UI content
     * has text, borders, and controls. The detector samples the image, finds rows
     * and columns that contain contrast edges, and returns their bounding box
     * with a small margin. A photo has edges everywhere and is therefore left
     * untouched, and overly small content boxes are ignored.
     */
    function detectContentRect(element) {
      const naturalWidth = element.naturalWidth;
      const naturalHeight = element.naturalHeight;
      if (naturalWidth < 32 || naturalHeight < 32) return null;
      const maxSide = 640;
      const scale = Math.min(1, maxSide / Math.max(naturalWidth, naturalHeight));
      const width = Math.max(4, Math.round(naturalWidth * scale));
      const height = Math.max(4, Math.round(naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const target = canvas.getContext('2d', { willReadFrequently: true });
      if (target === null) return null;
      target.drawImage(element, 0, 0, width, height);
      let data;
      try {
        data = target.getImageData(0, 0, width, height).data;
      } catch {
        return null;
      }
      const gray = new Float32Array(width * height);
      for (let index = 0; index < width * height; index += 1) {
        const offset = index * 4;
        const alpha = data[offset + 3] / 255;
        gray[index] = (data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114) * alpha;
      }
      const threshold = 18;
      const rowEdges = new Uint32Array(height);
      const columnEdges = new Uint32Array(width);
      for (let y = 0; y < height; y += 1) {
        const base = y * width;
        for (let x = 0; x < width; x += 1) {
          const current = gray[base + x];
          let edge = false;
          if (x + 1 < width && Math.abs(gray[base + x + 1] - current) >= threshold) edge = true;
          else if (x > 0 && Math.abs(gray[base + x - 1] - current) >= threshold) edge = true;
          if (!edge) {
            if (y + 1 < height && Math.abs(gray[base + width + x] - current) >= threshold) edge = true;
            else if (y > 0 && Math.abs(gray[base - width + x] - current) >= threshold) edge = true;
          }
          if (edge) {
            rowEdges[y] += 1;
            columnEdges[x] += 1;
          }
        }
      }
      const minRowEdges = Math.max(2, Math.floor(width * 0.006));
      const minColumnEdges = Math.max(2, Math.floor(height * 0.006));
      let top = 0;
      while (top < height && rowEdges[top] < minRowEdges) top += 1;
      if (top >= height) return null;
      let bottom = height - 1;
      while (bottom >= 0 && rowEdges[bottom] < minRowEdges) bottom -= 1;
      let left = 0;
      while (left < width && columnEdges[left] < minColumnEdges) left += 1;
      let right = width - 1;
      while (right >= 0 && columnEdges[right] < minColumnEdges) right -= 1;
      if (bottom <= top || right <= left) return null;
      const trimmedWidth = right - left + 1;
      const trimmedHeight = bottom - top + 1;
      const removed = 1 - (trimmedWidth * trimmedHeight) / (width * height);
      if (removed < 0.05) return null;
      const padding = Math.max(2, Math.round(4 / scale));
      const rect = {
        x: Math.max(0, Math.floor((left - padding) / scale)),
        y: Math.max(0, Math.floor((top - padding) / scale)),
        width: 0,
        height: 0,
      };
      rect.width = Math.min(naturalWidth - rect.x, Math.ceil((trimmedWidth + padding * 2) / scale));
      rect.height = Math.min(naturalHeight - rect.y, Math.ceil((trimmedHeight + padding * 2) / scale));
      if (rect.width < naturalWidth * 0.25 || rect.height < naturalHeight * 0.25) return null;
      return rect;
    }

    /* ------------------------------------------------------------------ */
    /* Small components                                                    */
    /* ------------------------------------------------------------------ */

    /** Composer tool-row button: opens the annotation editor for this Session. */
    function AnnotateButton(props) {
      const t = props.__t;
      const inputActions = props.inputActions;
      const sessionId = props.sessionId;

      React.useEffect(() => {
        const handler = async (text) => {
          const actions = inputActions;
          if (actions === undefined || typeof actions.insertText !== 'function') return false;
          const span = typeof actions.captureInsertion === 'function' ? actions.captureInsertion() : undefined;
          const result = actions.insertText(text, span);
          if (result !== undefined && typeof result.then === 'function') await result;
          if (typeof actions.focus === 'function') {
            try {
              const focused = actions.focus();
              if (focused !== undefined && typeof focused.then === 'function') await focused;
            } catch {
              // Insertion already happened; focus is a convenience only.
            }
          }
          return true;
        };
        return store.setInsertHandler(handler);
      }, [inputActions]);

      return h('button', {
        type: 'button',
        className: 'sa-annotate-btn',
        title: t('annotateButton'),
        'aria-label': t('annotateButton'),
        onClick: () => store.open(sessionId),
      }, h(Icon, { name: 'point', size: 15 }));
    }

    function ToolButton({ active, title, name, onClick }) {
      return h('button', {
        type: 'button',
        className: active ? 'sa-tool sa-active' : 'sa-tool',
        title,
        'aria-label': title,
        'aria-pressed': active === true,
        onClick,
      }, h(Icon, { name, size: 15 }));
    }

    /* ------------------------------------------------------------------ */
    /* Editor                                                              */
    /* ------------------------------------------------------------------ */

    function ScreenshotEditor({ sessionId, t }) {
      const [image, setImage] = React.useState(null);
      const [markers, setMarkers] = React.useState([]);
      const [tool, setTool] = React.useState('point');
      const [colorIndex, setColorIndex] = React.useState(0);
      const [selectedId, setSelectedId] = React.useState(undefined);
      const [zoom, setZoom] = React.useState(1);
      const [sideCollapsed, setSideCollapsed] = React.useState(false);
      const [quality, setQuality] = React.useState(768);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const [showLegend, setShowLegend] = React.useState(false);
      const [temp, setTemp] = React.useState(null);
      const [cropHistoryVersion, setCropHistoryVersion] = React.useState(0);
      const [contextMenu, setContextMenu] = React.useState(null);
      const [mergeSelection, setMergeSelection] = React.useState([]);
      const [format, setFormat] = React.useState('png');
      const [textOnly, setTextOnly] = React.useState(false);
      const [batch, setBatch] = React.useState([]);
      const [styleDefaults, setStyleDefaults] = React.useState({
        dashed: false,
        doubleHead: false,
        weight: 2,
        curve: 0,
      });
      const [imageKey, setImageKey] = React.useState(undefined);
      const [spaceHeld, setSpaceHeld] = React.useState(false);

      const svgRef = React.useRef(null);
      const stageRef = React.useRef(null);
      const stageInnerRef = React.useRef(null);
      const spacePressedRef = React.useRef(false);
      const panRef = React.useRef(undefined);
      const manualZoomRef = React.useRef(false);
      const fileRef = React.useRef(null);
      const objectUrlsRef = React.useRef(new Set());
      const imageHistoryRef = React.useRef([]);
      const dragRef = React.useRef(undefined);
      const historyRef = React.useRef({ past: [], future: [] });
      const nextNumberRef = React.useRef(1);
      const colorCursorRef = React.useRef(0);
      const markersRef = React.useRef(markers);
      const batchRef = React.useRef(batch);
      const selectedRef = React.useRef(selectedId);
      const loadFileRef = React.useRef(() => {});
      const closedRef = React.useRef(false);

      markersRef.current = markers;
      selectedRef.current = selectedId;
      batchRef.current = batch;

      /** Replace the working image and clear markers and history. */
      const loadFile = React.useCallback((file) => {
        if (file === undefined || file === null) return;
        if (!String(file.type || '').startsWith('image/')) {
          setNotice(t('onlyImages'));
          return;
        }
        const url = URL.createObjectURL(file);
        objectUrlsRef.current.add(url);
        const hashPromise = hashFile(file);
        const element = new Image();
        element.onload = async () => {
          const name = typeof file.name === 'string' && file.name !== '' ? file.name : 'screenshot.png';
          let finalElement = element;
          let finalUrl = url;
          let finalWidth = element.naturalWidth;
          let finalHeight = element.naturalHeight;
          let noticeText = '';
          try {
            const rect = detectContentRect(element);
            if (rect !== null) {
              const cropped = cropToDataUrl(element, rect);
              const croppedElement = await loadImageElement(cropped.dataUrl);
              imageHistoryRef.current.push({
                element: finalElement,
                url: finalUrl,
                width: finalWidth,
                height: finalHeight,
                name,
              });
              finalElement = croppedElement;
              finalUrl = cropped.dataUrl;
              finalWidth = cropped.width;
              finalHeight = cropped.height;
              noticeText = t('autoTrimNotice').replace('{w}', String(finalWidth)).replace('{h}', String(finalHeight));
              setCropHistoryVersion((value) => value + 1);
            }
          } catch {
            // A failed trim keeps the original image.
          }
          const hash = await hashPromise;
          const storageKey = hash === undefined ? undefined : `${hash}:${finalWidth}x${finalHeight}`;
          setImageKey(storageKey);
          setImage({
            element: finalElement,
            url: finalUrl,
            width: finalWidth,
            height: finalHeight,
            name,
          });
          setMergeSelection([]);
          historyRef.current = { past: [], future: [] };
          nextNumberRef.current = 1;
          colorCursorRef.current = 0;
          setColorIndex(0);
          setSelectedId(undefined);
          setTool('point');
          let restored = false;
          if (storageKey !== undefined) {
            const stored = readAnnotationStorage()[storageKey];
            if (stored !== undefined && stored !== null
              && stored.width === finalWidth && stored.height === finalHeight
              && Array.isArray(stored.markers)) {
              const restoredMarkers = renumberMarkers(stored.markers.map((marker) => ({ ...marker })));
              setMarkers(restoredMarkers);
              nextNumberRef.current = restoredMarkers.reduce((max, marker) => Math.max(max, marker.id), 0) + 1;
              restored = restoredMarkers.length > 0;
            } else {
              setMarkers([]);
            }
          } else {
            setMarkers([]);
          }
          setNotice(restored ? t('annotationsRestored') : noticeText);
        };
        element.onerror = () => {
          setNotice(`${t('errorPrefix')}${t('onlyImages')}`);
        };
        element.src = url;
      }, [t]);
      loadFileRef.current = loadFile;

      React.useEffect(() => {
        if (image === null || imageKey === undefined) return undefined;
        const timer = setTimeout(() => {
          const storage = readAnnotationStorage();
          delete storage[imageKey];
          const entries = Object.entries(storage);
          if (markers.length > 0) {
            entries.push([imageKey, {
              width: image.width,
              height: image.height,
              markers,
              updatedAt: Date.now(),
            }]);
          }
          entries.sort((left, right) => (right[1].updatedAt ?? 0) - (left[1].updatedAt ?? 0));
          writeAnnotationStorage(Object.fromEntries(entries.slice(0, STORAGE_LIMIT)));
        }, 500);
        return () => clearTimeout(timer);
      }, [markers, image, imageKey]);

      React.useEffect(() => () => {
        for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
        objectUrlsRef.current.clear();
      }, []);

      React.useEffect(() => {
        const onPaste = (event) => {
          const items = event.clipboardData === null || event.clipboardData === undefined
            ? []
            : Array.from(event.clipboardData.items ?? []);
          for (const item of items) {
            if (typeof item.type === 'string' && item.type.startsWith('image/')) {
              const file = item.getAsFile();
              if (file !== null) {
                event.preventDefault();
                if (markersRef.current.length > 0) setNotice(t('imageReplaced'));
                loadFileRef.current(file);
                return;
              }
            }
          }
        };
        document.addEventListener('paste', onPaste);
        return () => document.removeEventListener('paste', onPaste);
      }, [t]);

      const pushHistory = React.useCallback((previous) => {
        historyRef.current.past.push(previous);
        if (historyRef.current.past.length > 60) historyRef.current.past.shift();
        historyRef.current.future = [];
      }, []);

      const undo = React.useCallback(() => {
        const history = historyRef.current;
        if (history.past.length === 0) return;
        history.future.push(markersRef.current);
        const previous = history.past.pop();
        setMarkers(previous);
        setSelectedId(undefined);
        setMergeSelection([]);
      }, []);

      const redo = React.useCallback(() => {
        const history = historyRef.current;
        if (history.future.length === 0) return;
        history.past.push(markersRef.current);
        const next = history.future.pop();
        setMarkers(next);
        setSelectedId(undefined);
        setMergeSelection([]);
      }, []);

      React.useEffect(() => {
        const onKeyDown = (event) => {
          const target = event.target;
          const inField = target !== null && target !== undefined
            && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable === true);
          if (event.key === 'Escape') {
            event.preventDefault();
            if (mergeSelection.length > 0) {
              setMergeSelection([]);
              return;
            }
            if (selectedRef.current !== undefined) {
              setSelectedId(undefined);
              return;
            }
            if ((markersRef.current.length > 0 || batchRef.current.length > 0) && !window.confirm(t('closeConfirm'))) return;
            closedRef.current = true;
            store.close();
            return;
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
            if (inField) return;
            event.preventDefault();
            if (event.shiftKey) redo();
            else undo();
            return;
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
            if (inField) return;
            event.preventDefault();
            redo();
            return;
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
            if (inField) return;
            event.preventDefault();
            duplicateSelected();
            return;
          }
          if ((event.key === 'Delete' || event.key === 'Backspace') && !inField) {
            const ids = mergeSelection.length > 0
              ? mergeSelection
              : selectedRef.current === undefined ? [] : [selectedRef.current];
            if (ids.length === 0) return;
            event.preventDefault();
            pushHistory(markersRef.current);
            const idSet = new Set(ids);
            setMarkers(renumberMarkers(markersRef.current.filter((marker) => !idSet.has(marker.id))));
            setSelectedId(undefined);
            setMergeSelection([]);
            return;
          }
          if (!inField && !event.ctrlKey && !event.metaKey && !event.altKey) {
            const toolKeys = { m: 'move', p: 'point', r: 'rect', a: 'arrow', l: 'ruler', x: 'redact', c: 'crop' };
            const nextTool = toolKeys[event.key.toLowerCase()];
            if (nextTool !== undefined) {
              event.preventDefault();
              setTool(nextTool);
            }
          }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [t, undo, redo, pushHistory, duplicateSelected, mergeSelection, image]);

      React.useEffect(() => {
        const onShift = (event) => {
          if (event.key !== 'Shift') return;
          const drag = dragRef.current;
          if (drag === undefined || drag.mode !== 'draw' || drag.kind !== 'ruler' || drag.lastPoint === undefined) return;
          const target = event.shiftKey ? snapAnglePoint(drag.start, drag.lastPoint) : drag.lastPoint;
          setTemp({ kind: 'ruler', x1: drag.start.x, y1: drag.start.y, x2: target.x, y2: target.y });
        };
        window.addEventListener('keydown', onShift);
        window.addEventListener('keyup', onShift);
        return () => {
          window.removeEventListener('keydown', onShift);
          window.removeEventListener('keyup', onShift);
        };
      }, []);

      React.useEffect(() => {
        const isField = (target) => target !== null && target !== undefined
          && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable === true);
        const onDown = (event) => {
          if (event.code !== 'Space' || isField(event.target)) return;
          event.preventDefault();
          spacePressedRef.current = true;
          setSpaceHeld(true);
        };
        const onUp = (event) => {
          if (event.code !== 'Space') return;
          spacePressedRef.current = false;
          setSpaceHeld(false);
        };
        window.addEventListener('keydown', onDown);
        window.addEventListener('keyup', onUp);
        return () => {
          window.removeEventListener('keydown', onDown);
          window.removeEventListener('keyup', onUp);
        };
      }, []);

      React.useEffect(() => {
        const stage = stageRef.current;
        if (stage === null || image === null) return undefined;
        const onWheel = (event) => {
          event.preventDefault();
          if (event.shiftKey) {
            stage.scrollLeft += event.deltaY;
            return;
          }
          manualZoomRef.current = true;
          const factor = event.deltaY > 0 ? 1 / 1.12 : 1.12;
          const natural = toNatural(event);
          setZoom((previous) => {
            const next = clamp(Number((previous * factor).toFixed(4)), 0.05, 3);
            requestAnimationFrame(() => {
              const inner = stageInnerRef.current;
              if (inner === null) return;
              const rect = inner.getBoundingClientRect();
              const pointX = rect.left + natural.x * next;
              const pointY = rect.top + natural.y * next;
              stage.scrollLeft += pointX - event.clientX;
              stage.scrollTop += pointY - event.clientY;
            });
            return next;
          });
        };
        stage.addEventListener('wheel', onWheel, { passive: false });
        return () => stage.removeEventListener('wheel', onWheel);
      }, [image]);

      const toNatural = (event) => {
        const svg = svgRef.current;
        if (svg === null || image === null) return { x: 0, y: 0 };
        const rect = svg.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
        return {
          x: clamp((event.clientX - rect.left) * image.width / rect.width, 0, image.width),
          y: clamp((event.clientY - rect.top) * image.height / rect.height, 0, image.height),
        };
      };

      const hitTest = (point) => {
        if (image === null) return undefined;
        const radius = badgeRadiusFor(image);
        for (let index = markersRef.current.length - 1; index >= 0; index -= 1) {
          const marker = markersRef.current[index];
          if (marker.kind === 'point') {
            if (Math.hypot(point.x - marker.x1, point.y - marker.y1) <= radius * 1.6) return marker;
            continue;
          }
          if (marker.kind === 'rect') {
            const left = Math.min(marker.x1, marker.x2) - radius * 0.5;
            const right = Math.max(marker.x1, marker.x2) + radius * 0.5;
            const top = Math.min(marker.y1, marker.y2) - radius * 0.5;
            const bottom = Math.max(marker.y1, marker.y2) + radius * 0.5;
            if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) return marker;
            continue;
          }
          if (marker.kind === 'arrow' && (marker.curve ?? 0) !== 0) {
            const control = arrowControlPoint(marker);
            const start = { x: marker.x1, y: marker.y1 };
            const end = { x: marker.x2, y: marker.y2 };
            let distance = Infinity;
            let previous = start;
            for (let step = 1; step <= 16; step += 1) {
              const current = quadraticPoint(start, control, end, step / 16);
              distance = Math.min(distance, distanceToSegment(point, previous, current));
              previous = current;
            }
            if (distance <= Math.max(10, radius * 0.9)) return marker;
            continue;
          }
          const dx = marker.x2 - marker.x1;
          const dy = marker.y2 - marker.y1;
          const lengthSq = dx * dx + dy * dy;
          const ratio = lengthSq === 0 ? 0 : clamp(((point.x - marker.x1) * dx + (point.y - marker.y1) * dy) / lengthSq, 0, 1);
          const distance = Math.hypot(point.x - (marker.x1 + ratio * dx), point.y - (marker.y1 + ratio * dy));
          if (distance <= Math.max(10, radius * 0.9)) return marker;
        }
        return undefined;
      };

      const addMarker = (shape) => {
        const id = nextNumberRef.current;
        nextNumberRef.current += 1;
        const color = MARKER_COLORS[colorCursorRef.current % MARKER_COLORS.length];
        colorCursorRef.current += 1;
        setColorIndex(colorCursorRef.current % MARKER_COLORS.length);
        const marker = {
          id,
          no: 0,
          groupId: id,
          kind: shape.kind,
          color: color.id,
          x1: shape.x1,
          y1: shape.y1,
          x2: shape.x2 !== undefined ? shape.x2 : shape.x1,
          y2: shape.y2 !== undefined ? shape.y2 : shape.y1,
          comment: '',
          dashed: styleDefaults.dashed,
          doubleHead: styleDefaults.doubleHead,
          weight: styleDefaults.weight,
          curve: shape.kind === 'arrow' ? styleDefaults.curve : 0,
        };
        pushHistory(markersRef.current);
        setMarkers(renumberMarkers([...markersRef.current, marker]));
        setSelectedId(id);
      };

      /** Delete one shape; the remaining groups are renumbered without gaps. */
      const removeMarker = (id) => {
        pushHistory(markersRef.current);
        setMarkers(renumberMarkers(markersRef.current.filter((marker) => marker.id !== id)));
        setSelectedId(undefined);
        setMergeSelection((previous) => previous.filter((candidate) => candidate !== id));
      };

      /** Delete every shape of one group. */
      const removeGroup = (groupId) => {
        pushHistory(markersRef.current);
        const removedIds = new Set(markersRef.current.filter((marker) => marker.groupId === groupId).map((marker) => marker.id));
        setMarkers(renumberMarkers(markersRef.current.filter((marker) => marker.groupId !== groupId)));
        setSelectedId(undefined);
        setMergeSelection((previous) => previous.filter((candidate) => !removedIds.has(candidate)));
      };

      /** One comment is shared by every shape of the group. */
      const updateGroupComment = (groupId, comment) => {
        setMarkers((previous) => previous.map((marker) => (
          marker.groupId === groupId ? { ...marker, comment } : marker
        )));
      };

      const toggleMergeSelection = (id) => {
        setMergeSelection((previous) => (previous.includes(id)
          ? previous.filter((candidate) => candidate !== id)
          : [...previous, id]));
      };

      /** Merge the checked shapes under one number, color, and comment. */
      const mergeSelected = () => {
        if (mergeSelection.length < 2) return;
        const selected = markersRef.current.filter((marker) => mergeSelection.includes(marker.id));
        if (selected.length < 2) return;
        const target = selected[0];
        pushHistory(markersRef.current);
        setMarkers(renumberMarkers(markersRef.current.map((marker) => (
          mergeSelection.includes(marker.id)
            ? { ...marker, groupId: target.groupId, color: target.color, comment: target.comment }
            : marker
        ))));
        setSelectedId(target.id);
        setMergeSelection([]);
      };

      /** Turn every shape of a group into its own group. */
      const ungroupGroup = (groupId) => {
        pushHistory(markersRef.current);
        setMarkers(renumberMarkers(markersRef.current.map((marker) => (
          marker.groupId === groupId ? { ...marker, groupId: marker.id } : marker
        ))));
        setMergeSelection([]);
      };

      /** Copy the current selection a little down-right, keeping groups together. */
      const duplicateSelected = () => {
        if (image === null) return;
        const ids = mergeSelection.length > 0
          ? mergeSelection
          : selectedId === undefined ? [] : [selectedId];
        if (ids.length === 0) return;
        pushHistory(markersRef.current);
        const offsetX = image.width * 0.03;
        const offsetY = image.height * 0.03;
        let nextId = nextNumberRef.current;
        const groupMap = new Map();
        const clones = markersRef.current.filter((marker) => ids.includes(marker.id)).map((marker) => {
          const id = nextId;
          nextId += 1;
          let groupId = groupMap.get(marker.groupId);
          if (groupId === undefined) {
            groupId = id;
            groupMap.set(marker.groupId, groupId);
          }
          return {
            ...marker,
            id,
            groupId,
            x1: clamp(marker.x1 + offsetX, 0, image.width),
            y1: clamp(marker.y1 + offsetY, 0, image.height),
            x2: clamp(marker.x2 + offsetX, 0, image.width),
            y2: clamp(marker.y2 + offsetY, 0, image.height),
          };
        });
        if (clones.length === 0) return;
        nextNumberRef.current = nextId;
        setMarkers(renumberMarkers([...markersRef.current, ...clones]));
        setMergeSelection(clones.map((marker) => marker.id));
        setSelectedId(clones[0].id);
      };

      const onPointerDown = (event) => {
        if (image === null) return;
        if (event.button === 1 || spacePressedRef.current) {
          event.preventDefault();
          dragRef.current = {
            mode: 'pan',
            startClientX: event.clientX,
            startClientY: event.clientY,
            startLeft: stageRef.current?.scrollLeft ?? 0,
            startTop: stageRef.current?.scrollTop ?? 0,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        if (event.button !== 0) return;
        const point = toNatural(event);
        if (tool === 'move') {
          const hit = hitTest(point);
          if (event.shiftKey) {
            if (hit !== undefined) {
              toggleMergeSelection(hit.id);
              setSelectedId(hit.id);
              return;
            }
            dragRef.current = { mode: 'marquee', start: point, additive: true };
            setTemp({ kind: 'marquee', x1: point.x, y1: point.y, x2: point.x, y2: point.y });
            event.currentTarget.setPointerCapture(event.pointerId);
            return;
          }
          if (hit !== undefined) {
            const ids = mergeSelection.includes(hit.id) && mergeSelection.length > 1
              ? mergeSelection
              : [hit.id];
            setSelectedId(hit.id);
            if (ids.length === 1) setMergeSelection([]);
            pushHistory(markersRef.current);
            dragRef.current = {
              mode: 'move',
              ids,
              start: point,
              originals: markersRef.current
                .filter((marker) => ids.includes(marker.id))
                .map((marker) => ({
                  id: marker.id,
                  x1: marker.x1,
                  y1: marker.y1,
                  x2: marker.x2,
                  y2: marker.y2,
                })),
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            return;
          }
          dragRef.current = { mode: 'marquee', start: point, additive: false };
          setTemp({ kind: 'marquee', x1: point.x, y1: point.y, x2: point.x, y2: point.y });
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        setSelectedId(undefined);
        if (tool === 'point') {
          addMarker({ kind: 'point', x1: point.x, y1: point.y });
          return;
        }
        if (tool === 'crop') {
          dragRef.current = { mode: 'crop', start: point };
          setTemp({ kind: 'crop', x1: point.x, y1: point.y, x2: point.x, y2: point.y });
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        dragRef.current = { mode: 'draw', kind: tool, start: point };
        setTemp({ kind: tool, x1: point.x, y1: point.y, x2: point.x, y2: point.y });
        event.currentTarget.setPointerCapture(event.pointerId);
      };

      const onPointerMove = (event) => {
        const drag = dragRef.current;
        if (drag === undefined || image === null) return;
        if (drag.mode === 'pan') {
          const stage = stageRef.current;
          if (stage !== null) {
            stage.scrollLeft = drag.startLeft - (event.clientX - drag.startClientX);
            stage.scrollTop = drag.startTop - (event.clientY - drag.startClientY);
          }
          return;
        }
        const point = toNatural(event);
        if (drag.mode === 'marquee') {
          drag.lastPoint = point;
          setTemp({ kind: 'marquee', x1: drag.start.x, y1: drag.start.y, x2: point.x, y2: point.y });
          return;
        }
        if (drag.mode === 'draw' || drag.mode === 'crop') {
          const kind = drag.kind ?? 'crop';
          drag.lastPoint = point;
          const target = kind === 'ruler' && event.shiftKey ? snapAnglePoint(drag.start, point) : point;
          setTemp({ kind, x1: drag.start.x, y1: drag.start.y, x2: target.x, y2: target.y });
          return;
        }
        const dx = point.x - drag.start.x;
        const dy = point.y - drag.start.y;
        const originals = drag.originals ?? [];
        setMarkers((previous) => previous.map((marker) => {
          const original = originals.find((candidate) => candidate.id === marker.id);
          if (original === undefined) return marker;
          return {
            ...marker,
            x1: clamp(original.x1 + dx, 0, image.width),
            y1: clamp(original.y1 + dy, 0, image.height),
            x2: clamp(original.x2 + dx, 0, image.width),
            y2: clamp(original.y2 + dy, 0, image.height),
          };
        }));
      };

      const onPointerUp = (event) => {
        const drag = dragRef.current;
        dragRef.current = undefined;
        if (drag !== undefined && drag.mode === 'pan') {
          if (typeof event.currentTarget.releasePointerCapture === 'function') {
            try {
              event.currentTarget.releasePointerCapture(event.pointerId);
            } catch {
              // Pointer capture may already be gone.
            }
          }
          return;
        }
        if (drag !== undefined && drag.mode === 'marquee') {
          const shape = temp;
          setTemp(null);
          if (shape !== null) {
            const left = Math.min(shape.x1, shape.x2);
            const right = Math.max(shape.x1, shape.x2);
            const top = Math.min(shape.y1, shape.y2);
            const bottom = Math.max(shape.y1, shape.y2);
            const radius = badgeRadiusFor(image);
            const ids = markersRef.current.filter((marker) => {
              if (marker.kind === 'point') {
                return marker.x1 >= left && marker.x1 <= right && marker.y1 >= top && marker.y1 <= bottom;
              }
              const markerLeft = Math.min(marker.x1, marker.x2) - radius;
              const markerRight = Math.max(marker.x1, marker.x2) + radius;
              const markerTop = Math.min(marker.y1, marker.y2) - radius;
              const markerBottom = Math.max(marker.y1, marker.y2) + radius;
              return markerLeft <= right && markerRight >= left && markerTop <= bottom && markerBottom >= top;
            }).map((marker) => marker.id);
            setMergeSelection((previous) => (drag.additive ? [...new Set([...previous, ...ids])] : ids));
            setSelectedId(ids[0]);
          }
        } else if (drag !== undefined && drag.mode === 'crop') {
          const shape = temp;
          setTemp(null);
          if (shape !== null) {
            const width = Math.abs(shape.x2 - shape.x1);
            const height = Math.abs(shape.y2 - shape.y1);
            if (width >= 8 && height >= 8) {
              void applyCrop({
                x: Math.min(shape.x1, shape.x2),
                y: Math.min(shape.y1, shape.y2),
                width,
                height,
              });
            }
          }
        } else if (drag !== undefined && drag.mode === 'draw') {
          setTemp(null);
          const point = toNatural(event);
          const endPoint = drag.kind === 'ruler' && event.shiftKey ? snapAnglePoint(drag.start, point) : point;
          const shape = { kind: drag.kind, x1: drag.start.x, y1: drag.start.y, x2: endPoint.x, y2: endPoint.y };
          const width = Math.abs(shape.x2 - shape.x1);
          const height = Math.abs(shape.y2 - shape.y1);
          if (shape.kind === 'redact') {
            if (width >= 8 && height >= 8) {
              void applyRedact({
                x: Math.min(shape.x1, shape.x2),
                y: Math.min(shape.y1, shape.y2),
                width,
                height,
              });
            }
          } else {
            if (shape.kind === 'rect' && width < 6 && height < 6) return;
            if ((shape.kind === 'arrow' || shape.kind === 'ruler') && Math.hypot(width, height) < 10) return;
            addMarker(shape);
          }
        }
        if (typeof event.currentTarget.releasePointerCapture === 'function') {
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch {
            // Pointer capture may already be gone.
          }
        }
      };

      const onDrop = (event) => {
        event.preventDefault();
        const files = event.dataTransfer === null || event.dataTransfer === undefined
          ? []
          : Array.from(event.dataTransfer.files ?? []);
        const file = files.find((candidate) => String(candidate.type || '').startsWith('image/'));
        if (file !== undefined) {
          if (markersRef.current.length > 0) setNotice(t('imageReplaced'));
          loadFile(file);
        }
      };

      const selectedMarker = markers.find((marker) => marker.id === selectedId);

      const legendText = image === null ? '' : buildLegend('__PATH__', image, markers, quality, t);
      const markerGroups = groupMarkers(markers);

      const handleDownload = () => {
        if (image === null) return;
        try {
          const exported = renderExport(image, markersRef.current, quality, format);
          downloadDataUrl(exported.dataUrl, fileNameFor(image, exported.ext));
        } catch (error) {
          setNotice(`${t('errorPrefix')}${error instanceof Error ? error.message : String(error)}`);
        }
      };

      const addToBatch = () => {
        if (image === null) return;
        const next = [...batch, {
          image,
          markers: markersRef.current.slice(),
          quality,
          format,
          textOnly,
          name: image.name,
        }];
        setBatch(next);
        setImage(null);
        setImageKey(undefined);
        setMarkers([]);
        setMergeSelection([]);
        historyRef.current = { past: [], future: [] };
        nextNumberRef.current = 1;
        setSelectedId(undefined);
        setNotice(t('batchAdded').replace('{n}', String(next.length)));
      };

      const clearBatch = () => {
        setBatch([]);
        setNotice('');
      };

      const handleInsert = async () => {
        const items = [...batch];
        if (image !== null) {
          items.push({
            image,
            markers: markersRef.current.slice(),
            quality,
            format,
            textOnly,
            name: image.name,
          });
        }
        if (items.length === 0 || busy) return;
        setBusy(true);
        setNotice('');
        const savedItems = [];
        try {
          for (const item of items) {
            if (item.textOnly) {
              savedItems.push({
                image: item.image,
                markers: item.markers,
                path: undefined,
                width: item.image.width,
                height: item.image.height,
                textOnly: true,
                quality: item.quality,
                format: item.format,
              });
              continue;
            }
            const exported = renderExport(item.image, item.markers, item.quality, item.format);
            const saved = await saveAnnotation(sessionId, exported.dataUrl, exported.width, exported.height);
            savedItems.push({
              image: item.image,
              markers: item.markers,
              path: saved.path,
              width: saved.width ?? exported.width,
              height: saved.height ?? exported.height,
              textOnly: false,
              quality: item.quality,
              format: item.format,
            });
          }
        } catch (error) {
          const text = items.length === 1 && image !== null
            ? buildLegend(undefined, image, markersRef.current, quality, t, { textOnly })
            : buildBatchLegend(items.map((item) => ({ ...item, path: undefined })), t);
          if (image !== null) {
            try {
              const exported = renderExport(image, markersRef.current, quality, format);
              downloadDataUrl(exported.dataUrl, fileNameFor(image, exported.ext));
            } catch {
              // The image could not be rendered either; the copied text still carries the markers.
            }
          }
          await copyText(text);
          setNotice(t('saveFailed'));
          setBusy(false);
          return;
        }
        const text = savedItems.length === 1
          ? buildLegend(savedItems[0].path, savedItems[0].image, savedItems[0].markers, savedItems[0].quality, t, { textOnly: savedItems[0].textOnly })
          : buildBatchLegend(savedItems, t);
        const inserted = await store.insert(text);
        if (inserted) {
          setBatch([]);
          closedRef.current = true;
          store.close();
          return;
        }
        for (const savedItem of savedItems) {
          if (savedItem.textOnly) continue;
          try {
            const exported = renderExport(savedItem.image, savedItem.markers, savedItem.quality ?? quality, savedItem.format ?? format);
            downloadDataUrl(exported.dataUrl, fileNameFor(savedItem.image, exported.ext));
          } catch {
            // Keep trying the remaining items.
          }
        }
        await copyText(text);
        setNotice(t('insertFailed'));
        setBusy(false);
      };

      const handleClose = () => {
        if ((markers.length > 0 || batch.length > 0) && !window.confirm(t('closeConfirm'))) return;
        closedRef.current = true;
        store.close();
      };

      /** Horizontal screenshots get the marker panel below, so the image keeps full width. */
      const landscape = image !== null && image.width / image.height > 1.05;

      /** Absolute display scale that fits the stage: landscape fits both sides, portrait fits width. */
      const computeFitScale = React.useCallback((mode) => {
        if (image === null) return 1;
        const stage = stageRef.current;
        if (stage === null) return 1;
        const style = window.getComputedStyle(stage);
        const paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        const paddingY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
        const availableWidth = Math.max(80, stage.clientWidth - paddingX);
        const availableHeight = Math.max(80, stage.clientHeight - paddingY);
        const widthScale = availableWidth / image.width;
        if (mode === 'both') return Math.min(widthScale, availableHeight / image.height);
        return widthScale;
      }, [image]);

      /** Fit the screenshot so it is fully visible, without scrolling, when it first opens. */
      const applyAutoFit = React.useCallback(() => {
        if (image === null) return;
        manualZoomRef.current = false;
        const mode = image.width / image.height > 1.05 ? 'both' : 'width';
        setZoom(clamp(Number(computeFitScale(mode).toFixed(4)), 0.05, 3));
      }, [image, computeFitScale]);

      const useIsoLayoutEffect = React.useLayoutEffect === undefined ? React.useEffect : React.useLayoutEffect;
      useIsoLayoutEffect(() => {
        applyAutoFit();
      }, [image, applyAutoFit]);

      React.useEffect(() => {
        if (image === null) return undefined;
        const frame = requestAnimationFrame(() => {
          if (!manualZoomRef.current) applyAutoFit();
        });
        const timer = setTimeout(() => {
          if (!manualZoomRef.current) applyAutoFit();
        }, 180);
        return () => {
          cancelAnimationFrame(frame);
          clearTimeout(timer);
        };
      }, [image, sideCollapsed, applyAutoFit]);

      React.useEffect(() => {
        if (image !== null) setSideCollapsed(image.width / image.height > 1.05);
      }, [image]);

      React.useEffect(() => {
        if (image === null) return undefined;
        const stage = stageRef.current;
        if (stage === null || typeof ResizeObserver !== 'function') return undefined;
        const observer = new ResizeObserver(() => {
          if (!manualZoomRef.current) applyAutoFit();
        });
        observer.observe(stage);
        return () => observer.disconnect();
      }, [image, applyAutoFit]);

      const fitToView = () => {
        manualZoomRef.current = false;
        setZoom(clamp(Number(computeFitScale('both').toFixed(4)), 0.05, 3));
      };

      /** Remember the current image so a crop can be undone. */
      const pushImageHistory = (current) => {
        imageHistoryRef.current.push({
          element: current.element,
          url: current.url,
          width: current.width,
          height: current.height,
          name: current.name,
        });
        if (imageHistoryRef.current.length > 8) imageHistoryRef.current.shift();
        setCropHistoryVersion((value) => value + 1);
      };

      /** Replace the image with the dragged region and clear markers. */
      const applyCrop = async (rect) => {
        if (image === null) return;
        const x = clamp(rect.x, 0, image.width - 1);
        const y = clamp(rect.y, 0, image.height - 1);
        const width = Math.min(rect.width, image.width - x);
        const height = Math.min(rect.height, image.height - y);
        if (width < 8 || height < 8) return;
        if (markersRef.current.length > 0 && !window.confirm(t('cropConfirm'))) return;
        try {
          const cropped = cropToDataUrl(image.element, { x, y, width, height });
          const element = await loadImageElement(cropped.dataUrl);
          pushImageHistory(image);
          setImage({
            element,
            url: cropped.dataUrl,
            width: cropped.width,
            height: cropped.height,
            name: image.name,
          });
          setMarkers([]);
          setMergeSelection([]);
          historyRef.current = { past: [], future: [] };
          nextNumberRef.current = 1;
          colorCursorRef.current = 0;
          setColorIndex(0);
          setSelectedId(undefined);
          setTool('point');
          setImageKey(undefined);
          manualZoomRef.current = false;
          setNotice(t('croppedNotice').replace('{w}', String(cropped.width)).replace('{h}', String(cropped.height)));
        } catch (error) {
          setNotice(`${t('errorPrefix')}${error instanceof Error ? error.message : String(error)}`);
        }
      };

      /** Restore the image from before the last crop or auto-trim. */
      const restoreOriginalImage = () => {
        const previous = imageHistoryRef.current.pop();
        if (previous === undefined) return;
        const sameSize = image !== null && previous.width === image.width && previous.height === image.height;
        setImage(previous);
        if (!sameSize) {
          setMarkers([]);
          setMergeSelection([]);
          historyRef.current = { past: [], future: [] };
          nextNumberRef.current = 1;
          colorCursorRef.current = 0;
          setColorIndex(0);
          setSelectedId(undefined);
        }
        manualZoomRef.current = false;
        setCropHistoryVersion((value) => value + 1);
        setImageKey(undefined);
        setNotice(t('restoredNotice'));
      };

      /** Bake a pixelated rectangle into the image to hide sensitive content. */
      const applyRedact = async (rect) => {
        if (image === null) return;
        const x = clamp(rect.x, 0, image.width - 1);
        const y = clamp(rect.y, 0, image.height - 1);
        const width = Math.min(rect.width, image.width - x);
        const height = Math.min(rect.height, image.height - y);
        if (width < 8 || height < 8) return;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const target = canvas.getContext('2d');
          if (target === null) throw new Error('canvas 2d context is unavailable');
          target.drawImage(image.element, 0, 0);
          const block = 12;
          const smallWidth = Math.max(1, Math.round(width / block));
          const smallHeight = Math.max(1, Math.round(height / block));
          const small = document.createElement('canvas');
          small.width = smallWidth;
          small.height = smallHeight;
          const smallTarget = small.getContext('2d');
          if (smallTarget === null) throw new Error('canvas 2d context is unavailable');
          smallTarget.drawImage(image.element, x, y, width, height, 0, 0, smallWidth, smallHeight);
          target.imageSmoothingEnabled = false;
          target.drawImage(small, 0, 0, smallWidth, smallHeight, x, y, width, height);
          const dataUrl = canvas.toDataURL('image/png');
          const element = await loadImageElement(dataUrl);
          pushImageHistory(image);
          setImage({
            element,
            url: dataUrl,
            width: image.width,
            height: image.height,
            name: image.name,
          });
          setImageKey(undefined);
          setNotice(t('redactDone'));
        } catch (error) {
          setNotice(`${t('errorPrefix')}${error instanceof Error ? error.message : String(error)}`);
        }
      };

      React.useEffect(() => {
        if (contextMenu === null) return undefined;
        const close = () => setContextMenu(null);
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setContextMenu(null);
          }
        };
        window.addEventListener('pointerdown', close);
        window.addEventListener('keydown', onKey);
        return () => {
          window.removeEventListener('pointerdown', close);
          window.removeEventListener('keydown', onKey);
        };
      }, [contextMenu]);

      /** Open the type-and-color menu for the marker under the pointer, or for the next one. */
      const openContextMenu = (event) => {
        if (image === null) return;
        event.preventDefault();
        const point = toNatural(event);
        const hit = hitTest(point);
        setContextMenu({
          x: clamp(event.clientX, 8, Math.max(8, window.innerWidth - 256)),
          y: clamp(event.clientY, 8, Math.max(8, window.innerHeight - 430)),
          markerId: hit === undefined ? undefined : hit.id,
        });
        if (hit !== undefined) setSelectedId(hit.id);
      };

      const applyContextKind = (kind) => {
        const menu = contextMenu;
        setContextMenu(null);
        if (image === null || menu === null) return;
        if (menu.markerId === undefined) {
          setTool(kind);
          return;
        }
        pushHistory(markersRef.current);
        setMarkers((previous) => previous.map((marker) => (
          marker.id === menu.markerId ? convertMarkerShape(marker, kind, image) : marker
        )));
        setSelectedId(menu.markerId);
      };

      const applyContextColor = (color) => {
        const menu = contextMenu;
        setContextMenu(null);
        if (menu === null) return;
        if (menu.markerId === undefined) {
          const index = MARKER_COLORS.indexOf(color);
          if (index >= 0) {
            colorCursorRef.current = index;
            setColorIndex(index);
          }
          return;
        }
        const target = markersRef.current.find((marker) => marker.id === menu.markerId);
        if (target === undefined) return;
        pushHistory(markersRef.current);
        setMarkers((previous) => previous.map((marker) => (
          marker.groupId === target.groupId ? { ...marker, color: color.id } : marker
        )));
        setSelectedId(menu.markerId);
      };

      /** Apply a line style to the chosen marker(s), or make it the default for the next one. */
      const applyMarkerStyle = (patch) => {
        const menu = contextMenu;
        setContextMenu(null);
        if (menu === null) return;
        if (menu.markerId === undefined) {
          setStyleDefaults((previous) => ({ ...previous, ...patch }));
          return;
        }
        const ids = mergeSelection.includes(menu.markerId) && mergeSelection.length > 1
          ? mergeSelection
          : [menu.markerId];
        pushHistory(markersRef.current);
        setMarkers((previous) => previous.map((marker) => (
          ids.includes(marker.id) ? { ...marker, ...patch } : marker
        )));
        setSelectedId(menu.markerId);
      };

      /** Right-click menu: shape and color for an existing marker or for the next one. */
      const renderContextMenu = () => {
        if (contextMenu === null || image === null) return null;
        const current = contextMenu.markerId === undefined
          ? undefined
          : markers.find((marker) => marker.id === contextMenu.markerId);
        const currentKind = current === undefined ? tool : current.kind;
        const currentColor = current === undefined
          ? MARKER_COLORS[colorIndex % MARKER_COLORS.length].id
          : current.color;
        const currentStyle = current === undefined
          ? styleDefaults
          : {
            dashed: current.dashed === true,
            doubleHead: current.doubleHead === true,
            weight: current.weight ?? 2,
            curve: (current.curve ?? 0) !== 0 ? 0.45 : 0,
          };
        const styleOption = (label, active, patch) => h('button', {
          type: 'button',
          className: active ? 'sa-ctx-item sa-active' : 'sa-ctx-item',
          onClick: () => applyMarkerStyle(patch),
        }, label);
        const typeRow = h('div', { className: 'sa-ctx-row sa-ctx-types' },
          ['point', 'rect', 'arrow', 'ruler'].map((kind) => h('button', {
            key: kind,
            type: 'button',
            className: currentKind === kind ? 'sa-ctx-item sa-active' : 'sa-ctx-item',
            onClick: () => applyContextKind(kind),
          }, h(Icon, { name: kind, size: 14 }), t(kind === 'point' ? 'toolPoint' : kind === 'rect' ? 'toolRect' : kind === 'ruler' ? 'toolRuler' : 'toolArrow'))));
        const meaningRow = h('div', { className: 'sa-ctx-row sa-ctx-presets' },
          MARKER_COLORS.map((color) => h('button', {
            key: color.id,
            type: 'button',
            className: currentColor === color.id ? 'sa-ctx-preset sa-active' : 'sa-ctx-preset',
            title: t(COLOR_KEYS[color.id]),
            'aria-label': `${t(MEANING_BY_COLOR[color.id])} · ${t(COLOR_KEYS[color.id])}`,
            onClick: () => applyContextColor(color),
          }, h('span', { className: 'sa-preset-dot', style: { background: color.value } }),
          h('span', { className: 'sa-preset-label' }, t(MEANING_BY_COLOR[color.id])))));
        return h('div', {
          className: 'sa-ctx',
          style: { left: `${contextMenu.x}px`, top: `${contextMenu.y}px` },
          onPointerDown: (event) => event.stopPropagation(),
          onContextMenu: (event) => event.preventDefault(),
        },
        h('div', { className: 'sa-ctx-title' },
          current === undefined ? t('ctxNewMarker') : `${t('ctxMarker')} #${current.no}`),
        h('div', { className: 'sa-ctx-label' }, t('ctxType')),
        typeRow,
        h('div', { className: 'sa-ctx-label' }, t('ctxMeaning')),
        meaningRow,
        h('div', { className: 'sa-ctx-label' }, t('styleLine')),
        h('div', { className: 'sa-ctx-row' },
          styleOption(t('styleSolid'), currentStyle.dashed !== true, { dashed: false }),
          styleOption(t('styleDashed'), currentStyle.dashed === true, { dashed: true })),
        h('div', { className: 'sa-ctx-label' }, t('styleHeads')),
        h('div', { className: 'sa-ctx-row' },
          styleOption(t('styleOneHead'), currentStyle.doubleHead !== true, { doubleHead: false }),
          styleOption(t('styleTwoHeads'), currentStyle.doubleHead === true, { doubleHead: true })),
        h('div', { className: 'sa-ctx-label' }, t('styleWeight')),
        h('div', { className: 'sa-ctx-row' },
          styleOption(t('styleThin'), currentStyle.weight === 1, { weight: 1 }),
          styleOption(t('styleNormal'), currentStyle.weight !== 1 && currentStyle.weight !== 3, { weight: 2 }),
          styleOption(t('styleThick'), currentStyle.weight === 3, { weight: 3 })),
        h('div', { className: 'sa-ctx-label' }, t('styleShape')),
        h('div', { className: 'sa-ctx-row' },
          styleOption(t('styleStraight'), currentStyle.curve === 0, { curve: 0 }),
          styleOption(t('styleCurved'), currentStyle.curve !== 0, { curve: 0.45 }))
        );
      };

      const radius = image === null ? 0 : badgeRadiusFor(image);

      const badgePositions = image === null ? new Map() : computeBadgePositions(markers, image, radius);

      const renderMarkerShape = (marker) => {
        const color = colorById(marker.color);
        const isSelected = marker.id === selectedId || mergeSelection.includes(marker.id);
        const position = badgePositions.get(marker.id) ?? badgeBase(marker, radius);
        const badge = () => {
          const cx = clamp(position.x, radius, image.width - radius);
          const cy = clamp(position.y, radius, image.height - radius);
          return h('g', { key: 'badge' }, [
            h('circle', {
              key: 'ring',
              cx,
              cy,
              r: radius * 1.32,
              fill: 'none',
              stroke: isSelected ? '#ffffff' : 'rgba(255,255,255,0)',
              strokeWidth: Math.max(1.5, radius * 0.12),
              strokeDasharray: isSelected ? `${radius * 0.5} ${radius * 0.35}` : undefined,
            }),
            h('circle', {
              key: 'dot',
              cx,
              cy,
              r: radius,
              fill: color.value,
              stroke: 'rgba(255,255,255,0.96)',
              strokeWidth: Math.max(1.5, radius * 0.16),
            }),
            h('circle', {
              key: 'edge',
              cx,
              cy,
              r: radius,
              fill: 'none',
              stroke: 'rgba(0,0,0,0.3)',
              strokeWidth: Math.max(1, radius * 0.06),
            }),
            h('text', {
              key: 'no',
              x: cx,
              y: cy,
              fill: color.text,
              fontSize: radius * 1.32,
              fontWeight: 700,
              textAnchor: 'middle',
              dominantBaseline: 'central',
              style: { userSelect: 'none', pointerEvents: 'none' },
            }, String(marker.no)),
          ]);
        };
        const weight = marker.weight === 1 ? 0.7 : marker.weight === 3 ? 1.5 : 1;
        const strokeW = Math.max(2, image.width * 0.0026 * weight);
        const dash = marker.dashed === true ? `${radius * 0.9} ${radius * 0.6}` : undefined;
        if (marker.kind === 'point') {
          return h('g', { key: marker.id }, [badge()]);
        }
        if (marker.kind === 'rect') {
          const left = Math.min(marker.x1, marker.x2);
          const top = Math.min(marker.y1, marker.y2);
          const width = Math.abs(marker.x2 - marker.x1);
          const height = Math.abs(marker.y2 - marker.y1);
          return h('g', { key: marker.id }, [
            h('rect', {
              key: 'fill',
              x: left,
              y: top,
              width,
              height,
              fill: color.value,
              opacity: 0.16,
            }),
            h('rect', {
              key: 'line',
              x: left,
              y: top,
              width,
              height,
              fill: 'none',
              stroke: color.value,
              strokeWidth: strokeW,
              strokeDasharray: dash,
            }),
            badge(),
          ]);
        }
        if (marker.kind === 'ruler') {
          const dxr = marker.x2 - marker.x1;
          const dyr = marker.y2 - marker.y1;
          const angleR = Math.atan2(dyr, dxr);
          const tick = Math.max(10, radius * 0.9);
          const tickX = -Math.sin(angleR) * tick;
          const tickY = Math.cos(angleR) * tick;
          return h('g', { key: marker.id }, [
            h('line', {
              key: 'line',
              x1: marker.x1,
              y1: marker.y1,
              x2: marker.x2,
              y2: marker.y2,
              stroke: color.value,
              strokeWidth: strokeW,
              strokeLinecap: 'round',
              strokeDasharray: dash,
            }),
            h('path', {
              key: 'ticks',
              d: `M ${marker.x1 - tickX} ${marker.y1 - tickY} L ${marker.x1 + tickX} ${marker.y1 + tickY} `
                + `M ${marker.x2 - tickX} ${marker.y2 - tickY} L ${marker.x2 + tickX} ${marker.y2 + tickY}`,
              stroke: color.value,
              strokeWidth: strokeW,
              strokeLinecap: 'round',
              strokeDasharray: dash,
            }),
            badge(),
          ]);
        }
        const control = arrowControlPoint(marker);
        const curved = (marker.curve ?? 0) !== 0;
        const angle = arrowHeadAngle(marker, control);
        const head = Math.max(10, radius * 1.2);
        const headPolygon = (x, y, direction) => [
          `${x},${y}`,
          `${x - head * Math.cos(direction - Math.PI / 7)},${y - head * Math.sin(direction - Math.PI / 7)}`,
          `${x - head * Math.cos(direction + Math.PI / 7)},${y - head * Math.sin(direction + Math.PI / 7)}`,
        ].join(' ');
        const startAngle = curved
          ? Math.atan2(marker.y1 - control.y, marker.x1 - control.x)
          : angle + Math.PI;
        return h('g', { key: marker.id }, [
          h('path', {
            key: 'line',
            d: curved
              ? `M ${marker.x1} ${marker.y1} Q ${control.x} ${control.y} ${marker.x2} ${marker.y2}`
              : `M ${marker.x1} ${marker.y1} L ${marker.x2} ${marker.y2}`,
            fill: 'none',
            stroke: color.value,
            strokeWidth: strokeW,
            strokeLinecap: 'round',
            strokeDasharray: dash,
          }),
          h('polygon', {
            key: 'head',
            points: headPolygon(marker.x2, marker.y2, angle),
            fill: color.value,
            stroke: 'rgba(255,255,255,0.9)',
            strokeWidth: Math.max(1, image.width * 0.0012),
          }),
          marker.doubleHead === true
            ? h('polygon', {
              key: 'head-start',
              points: headPolygon(marker.x1, marker.y1, startAngle),
              fill: color.value,
              stroke: 'rgba(255,255,255,0.9)',
              strokeWidth: Math.max(1, image.width * 0.0012),
            })
            : null,
          badge(),
        ]);
      };

      return h('div', {
        className: 'sa-overlay',
        onDragOver: (event) => event.preventDefault(),
        onDrop,
      }, h('div', { className: 'sa-panel' },
        h('div', { className: 'sa-head' },
          h('div', null,
            h('h2', null, t('title')),
            h('p', null, t('subtitle'))),
          h('span', { className: 'sa-version', title: t('title') }, `v${EDITOR_VERSION}`),
          h('button', {
            type: 'button',
            className: 'sa-btn sa-icon sa-close',
            title: t('close'),
            'aria-label': t('close'),
            onClick: handleClose,
          }, h(Icon, { name: 'close', size: 15 }))),
        image === null
          ? h('div', { className: 'sa-body' },
            h('div', {
              className: 'sa-drop',
              onClick: () => fileRef.current?.click(),
              onDragOver: (event) => event.preventDefault(),
              onDrop,
            },
            h(Icon, { name: 'image', size: 28 }),
            h('strong', null, t('pasteHint')),
            h('span', null, t('dropHint')),
            h('button', {
              type: 'button',
              className: 'sa-btn',
              onClick: (event) => {
                event.stopPropagation();
                fileRef.current?.click();
              },
            }, t('chooseFile'))))
          : h('div', { className: landscape ? 'sa-body sa-landscape' : 'sa-body' },
            h('div', { className: 'sa-main' },
              h('div', { className: 'sa-toolbar' },
                h('div', { className: 'sa-group' },
                  h(ToolButton, { active: tool === 'move', title: t('toolMove'), name: 'move', onClick: () => { setTool('move'); setSelectedId(undefined); } }),
                  h(ToolButton, { active: tool === 'point', title: t('toolPoint'), name: 'point', onClick: () => setTool('point') }),
                  h(ToolButton, { active: tool === 'rect', title: t('toolRect'), name: 'rect', onClick: () => setTool('rect') }),
                  h(ToolButton, { active: tool === 'arrow', title: t('toolArrow'), name: 'arrow', onClick: () => setTool('arrow') }),
                  h(ToolButton, { active: tool === 'ruler', title: t('toolRuler'), name: 'ruler', onClick: () => setTool('ruler') }),
                  h(ToolButton, { active: tool === 'redact', title: t('toolRedact'), name: 'redact', onClick: () => setTool('redact') }),
                  h(ToolButton, { active: tool === 'crop', title: t('toolCrop'), name: 'crop', onClick: () => setTool('crop') })),
                h('div', { className: 'sa-group' },
                  h('div', { className: 'sa-swatches' },
                    MARKER_COLORS.map((color, index) => h('button', {
                      key: color.id,
                      type: 'button',
                      className: colorIndex === index ? 'sa-swatch sa-active' : 'sa-swatch',
                      title: `${t(MEANING_BY_COLOR[color.id])} · ${t(COLOR_KEYS[color.id])}`,
                      'aria-label': `${t(MEANING_BY_COLOR[color.id])} · ${t(COLOR_KEYS[color.id])}`,
                      style: { background: color.value },
                      onClick: () => {
                        colorCursorRef.current = index;
                        setColorIndex(index);
                      },
                    }))),
                  h('span', { className: 'sa-meaning-label' },
                    t(MEANING_BY_COLOR[MARKER_COLORS[colorIndex % MARKER_COLORS.length].id]))),
                h('div', { className: 'sa-group' },
                  h(ToolButton, { active: false, title: t('undo'), name: 'undo', onClick: undo }),
                  h(ToolButton, { active: false, title: t('redo'), name: 'redo', onClick: redo })),
                h('div', { className: 'sa-group' },
                  h('button', { type: 'button', className: 'sa-tool', title: t('zoomOut'), 'aria-label': t('zoomOut'), onClick: () => { manualZoomRef.current = true; setZoom((value) => clamp(Number((value / 1.15).toFixed(3)), 0.05, 3)); } }, '−'),
                  h('span', { className: 'sa-zoom' }, `${Math.round(zoom * 100)}%`),
                  h('button', { type: 'button', className: 'sa-tool', title: t('zoomIn'), 'aria-label': t('zoomIn'), onClick: () => { manualZoomRef.current = true; setZoom((value) => clamp(Number((value * 1.15).toFixed(3)), 0.05, 3)); } }, '+'),
                  h('button', { type: 'button', className: 'sa-tool sa-fit', title: t('fit'), 'aria-label': t('fit'), onClick: fitToView }, '⤢')),
                h('label', null,
                  t('quality'),
                  h('select', {
                    value: String(quality),
                    onChange: (event) => setQuality(Number(event.target.value)),
                  },
                  h('option', { value: '768' }, t('qMax')),
                  h('option', { value: '1024' }, t('qEconomy')),
                  h('option', { value: '1536' }, t('qDetail')),
                  h('option', { value: '0' }, t('qOriginal')))),
                h('span', {
                  className: 'sa-zoom',
                  style: { minWidth: 'auto' },
                  title: t('quality'),
                }, t('tokenEstimate').replace('{count}', String(estimateTokens(image, quality)))))),
              h('div', {
                className: landscape ? 'sa-stage sa-stage-landscape' : 'sa-stage',
                ref: stageRef,
                style: {
                  flex: '1 1 auto',
                  minHeight: 0,
                  overflow: 'auto',
                  padding: landscape ? '8px 12px' : '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'flex-start',
                  background: 'radial-gradient(circle at 30% 20%, rgba(255,255,255,.045), transparent 60%), #0b0d12',
                  cursor: spaceHeld ? 'grab' : 'default',
                },
                onContextMenu: openContextMenu,
              },
                h('div', {
                  ref: stageInnerRef,
                  className: 'sa-stage-inner',
                  style: { position: 'relative', flex: '0 0 auto', width: `${Math.max(1, Math.round(image.width * zoom))}px` },
                },
                  h('img', { src: image.url, alt: '', draggable: false, style: { display: 'block', width: '100%', height: 'auto' } }),
                  h('svg', {
                    ref: svgRef,
                    className: tool === 'move' ? 'sa-svg sa-move' : 'sa-svg',
                    viewBox: `0 0 ${image.width} ${image.height}`,
                    preserveAspectRatio: 'none',
                    onPointerDown,
                    onPointerMove,
                    onPointerUp,
                    onPointerCancel: onPointerUp,
                  },
                  markers.map(renderMarkerShape),
                  temp === null ? null : h('g', { key: 'temp', opacity: 0.85 },
                    ['rect', 'crop', 'marquee', 'redact'].includes(temp.kind)
                      ? h('rect', {
                        x: Math.min(temp.x1, temp.x2),
                        y: Math.min(temp.y1, temp.y2),
                        width: Math.abs(temp.x2 - temp.x1),
                        height: Math.abs(temp.y2 - temp.y1),
                        fill: temp.kind === 'rect'
                          ? colorById(MARKER_COLORS[colorIndex % MARKER_COLORS.length].id).value
                          : 'rgba(255,255,255,0.06)',
                        fillOpacity: temp.kind === 'rect' ? 0.16 : 1,
                        stroke: temp.kind === 'rect'
                          ? colorById(MARKER_COLORS[colorIndex % MARKER_COLORS.length].id).value
                          : '#ffffff',
                        strokeWidth: Math.max(2, image.width * 0.0026),
                        strokeDasharray: temp.kind === 'rect'
                          ? undefined
                          : `${image.width * 0.01} ${image.width * 0.006}`,
                      })
                      : h('line', {
                        x1: temp.x1,
                        y1: temp.y1,
                        x2: temp.x2,
                        y2: temp.y2,
                        stroke: colorById(MARKER_COLORS[colorIndex % MARKER_COLORS.length].id).value,
                        strokeWidth: Math.max(2, image.width * 0.0026),
                        strokeLinecap: 'round',
                      }))))),
            h('aside', { className: landscape ? `sa-side sa-side-below${sideCollapsed ? ' sa-collapsed' : ''}` : 'sa-side' },
              h('div', { className: 'sa-side-head' },
                t('markers'),
                h('span', { className: 'sa-count' }, String(markerGroups.length)),
                mergeSelection.length >= 2
                  ? h('button', {
                    type: 'button',
                    className: 'sa-btn sa-btn-small sa-merge',
                    onClick: mergeSelected,
                  }, t('merge').replace('{n}', String(mergeSelection.length)))
                  : null,
                landscape
                  ? h('button', {
                    type: 'button',
                    className: 'sa-btn sa-btn-small',
                    title: sideCollapsed ? t('expand') : t('collapse'),
                    onClick: () => setSideCollapsed((value) => !value),
                  }, sideCollapsed ? t('expand') : t('collapse'))
                  : null),
              markers.length >= 2
                ? h('div', { className: 'sa-group-hint' }, t('groupHint'))
                : null,
              markerGroups.length === 0
                ? h('div', { className: 'sa-empty' }, t('noMarkers'))
                : h('div', { className: 'sa-marker-list' },
                  markerGroups.map((group) => {
                    const leader = group.markers[0];
                    const color = colorById(leader.color);
                    const memberSelected = group.markers.some((marker) => marker.id === selectedId);
                    return h('div', {
                      key: group.id,
                      className: memberSelected ? 'sa-marker sa-selected' : 'sa-marker',
                    },
                    h('span', {
                      className: 'sa-badge',
                      style: { background: color.value, color: color.text },
                    }, String(leader.no)),
                    h('div', { className: 'sa-marker-body' },
                      h('div', { className: 'sa-marker-meta' },
                        group.markers.length === 1
                          ? `${t(MEANING_BY_COLOR[leader.color])} · ${t(COLOR_KEYS[leader.color])}`
                          : `${t('groupShapes').replace('{n}', String(group.markers.length))} · ${t(MEANING_BY_COLOR[leader.color])}`),
                      h('div', { className: 'sa-group-chips' },
                        group.markers.map((marker) => h('span', { key: marker.id, className: 'sa-chip' },
                          h('input', {
                            type: 'checkbox',
                            checked: mergeSelection.includes(marker.id),
                            onChange: () => toggleMergeSelection(marker.id),
                            'aria-label': `${t('markers')} #${marker.no}`,
                          }),
                          h('button', {
                            type: 'button',
                            className: 'sa-chip-label',
                            title: t(kindKey(marker.kind)),
                            onClick: () => setSelectedId(marker.id),
                          }, `${t(kindKey(marker.kind))} ${markerCoordinates(marker, image.width, image.height)}`),
                          h('button', {
                            type: 'button',
                            className: 'sa-chip-del',
                            title: t('deleteMarker'),
                            'aria-label': t('deleteMarker'),
                            onClick: () => removeMarker(marker.id),
                          }, '×')))),
                      h('textarea', {
                        value: leader.comment,
                        maxLength: MAX_COMMENT,
                        placeholder: t('commentPlaceholder'),
                        onFocus: () => setSelectedId(leader.id),
                        onChange: (event) => updateGroupComment(group.id, event.target.value),
                      }),
                      group.markers.length > 1
                        ? h('div', { className: 'sa-group-actions' },
                          h('button', {
                            type: 'button',
                            className: 'sa-btn sa-btn-small',
                            onClick: () => ungroupGroup(group.id),
                          }, t('ungroup')))
                        : null),
                    h('button', {
                      type: 'button',
                      className: 'sa-delete',
                      title: group.markers.length > 1 ? t('deleteGroup') : t('deleteMarker'),
                      'aria-label': group.markers.length > 1 ? t('deleteGroup') : t('deleteMarker'),
                      onClick: () => (group.markers.length > 1 ? removeGroup(group.id) : removeMarker(leader.id)),
                    }, h(Icon, { name: 'trash', size: 14 })));
                  })),
              h('details', {
                className: 'sa-legend',
                open: showLegend,
                onToggle: (event) => setShowLegend(event.currentTarget.open),
              },
              h('summary', null, showLegend ? t('hideLegend') : t('showLegend')),
              h('pre', null, legendText)))),
        h('div', { className: 'sa-foot' },
          h('span', { className: 'sa-foot-info' },
            image === null ? '' : `${image.width}×${image.height} px · ${t('tokenEstimate').replace('{count}', String(estimateTokens(image, quality)))}`,
            batch.length > 0 ? ` · ${t('batchCount').replace('{n}', String(batch.length))}` : ''),
          h('span', { className: 'sa-notice' }, notice),
          h('div', { className: 'sa-actions' },
            cropHistoryVersion > 0 && imageHistoryRef.current.length > 0
              ? h('button', {
                type: 'button',
                className: 'sa-btn',
                disabled: busy,
                onClick: restoreOriginalImage,
              }, t('restore'))
              : null,
            batch.length > 0
              ? h('button', {
                type: 'button',
                className: 'sa-btn',
                disabled: busy,
                onClick: clearBatch,
              }, t('batchClear'))
              : null,
            h('label', { className: 'sa-foot-field' },
              t('format'),
              h('select', {
                value: format,
                onChange: (event) => setFormat(event.target.value),
              },
              h('option', { value: 'png' }, 'PNG'),
              h('option', { value: 'jpeg' }, 'JPEG'),
              h('option', { value: 'webp' }, 'WebP'))),
            h('label', { className: 'sa-foot-check', title: t('textOnly') },
              h('input', {
                type: 'checkbox',
                checked: textOnly,
                onChange: (event) => setTextOnly(event.target.checked),
              }),
              t('textOnly')),
            image === null
              ? null
              : h('button', {
                type: 'button',
                className: 'sa-btn',
                disabled: busy,
                onClick: addToBatch,
              }, t('batchAdd')),
            h('button', {
              type: 'button',
              className: 'sa-btn',
              title: t('download'),
              disabled: image === null || busy,
              onClick: handleDownload,
            }, h(Icon, { name: 'download', size: 14 }), t('save')),
            image === null
              ? null
              : h('button', {
                type: 'button',
                className: 'sa-btn',
                disabled: busy,
                onClick: () => fileRef.current?.click(),
              }, t('replaceImage')),
            h('button', {
              type: 'button',
              className: 'sa-btn sa-primary',
              disabled: busy || (image === null && batch.length === 0),
              onClick: handleInsert,
            }, busy ? t('working') : t('insert')))),
        h('input', {
          ref: fileRef,
          type: 'file',
          accept: 'image/*',
          className: 'sa-hidden',
          onChange: (event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) {
              if (markersRef.current.length > 0) setNotice(t('imageReplaced'));
              loadFile(file);
            }
            event.target.value = '';
          },
        }),
      ),
      contextMenu === null || image === null ? null : renderContextMenu(),
    );
    }

    /** Format the legend text for the composer. */
    function buildMarkerLines(image, markers, t) {
      if (markers.length === 0) return [t('legendNoMarkers')];
      const lines = [];
      for (const group of groupMarkers(markers)) {
        const leader = group.markers[0];
        const color = t(COLOR_KEYS[leader.color] ?? 'colorRed');
        const meaning = meaningKeyFor(leader.color);
        const meaningText = meaning === undefined ? '' : ` (${t(meaning)})`;
        const comment = String(leader.comment ?? '').replace(/\s+/g, ' ').trim();
        const suffix = comment === '' ? '' : `: ${comment}`;
        const parts = group.markers.map((marker) => (
          `${t(kindKey(marker.kind))} ${markerCoordinates(marker, image.width, image.height)}`
        ));
        lines.push(`#${leader.no} ${color}${meaningText} ${parts.join(' + ')}${suffix}`);
      }
      return lines;
    }

    function buildLegend(filePath, image, markers, quality, t, options = {}) {
      const scale = quality > 0 ? Math.min(1, quality / Math.max(image.width, image.height)) : 1;
      const width = Math.round(image.width * scale);
      const height = Math.round(image.height * scale);
      const header = options.textOnly === true
        ? t('legendTextOnly')
        : filePath === undefined
          ? t('legendWithoutPath')
          : t('legendWithPath');
      const lines = [header.replace('{path}', filePath ?? '').replace('{w}', String(width)).replace('{h}', String(height))];
      if (markers.length === 0) {
        lines.push(t('legendNoMarkers'));
        return lines.join('\n');
      }
      lines.push(t('legendCoords'));
      lines.push(...buildMarkerLines(image, markers, t));
      return lines.join('\n');
    }

    function buildBatchLegend(items, t) {
      const lines = [t('legendBatch').replace('{n}', String(items.length))];
      items.forEach((item, index) => {
        const number = index + 1;
        if (item.textOnly || item.path === undefined) {
          lines.push(`${number}. ${t('itemText')}`);
        } else {
          lines.push(`${number}. ${item.path} (${item.width}×${item.height})`);
        }
        for (const markerLine of buildMarkerLines(item.image, item.markers, t)) {
          lines.push(`   ${markerLine}`);
        }
      });
      return lines.join('\n');
    }

    function fileNameFor(image, ext = 'png') {
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      return `annotated-${stamp}.${ext}`;
    }

    function downloadDataUrl(dataUrl, filename) {
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Clipboard access can be denied; the notice still tells the user what to do.
      }
    }

    async function saveAnnotation(sessionId, dataUrl, width, height) {
      const response = await fetch(SAVE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, dataUrl, width, height }),
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (!response.ok || payload === undefined || typeof payload.path !== 'string') {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      return payload;
    }

    /* ------------------------------------------------------------------ */
    /* Plugin                                                              */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['locale', 'slots'],
      apply(ctx) {
        const locale = ctx.locale;
        const effects = [];

        const registerLang = (language, dict) => {
          const dispose = locale.register(NAMESPACE, language, dict);
          effects.push(dispose);
        };
        registerLang('ru', RU);
        registerLang('en', EN);
        const t = locale.bind(NAMESPACE);

        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);
        effects.push(() => style.remove());

        const withText = (Component) => {
          const Wrapped = (props) => h(Component, { ...props, __t: t });
          Wrapped.displayName = Component.name === undefined ? 'ScreenshotAnnotator' : Component.name;
          return Wrapped;
        };

        const disposeButton = ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'screenshot-annotator',
          order: 65,
        }, withText(AnnotateButton)));
        effects.push(disposeButton);

        const disposeOverlay = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'screenshot-annotator-overlay',
          order: 300,
        }, withText(function Overlay() {
          const state = useStoreState();
          if (!state.open) return null;
          return h(ScreenshotEditor, { sessionId: state.sessionId, t });
        })));
        effects.push(disposeOverlay);

        ctx.effect(() => () => {
          for (const dispose of effects.reverse()) {
            try {
              const result = dispose();
              if (result !== undefined && typeof result.then === 'function') result.catch(() => {});
            } catch {
              // A disposer already ran; the remaining ones still need to run.
            }
          }
        }, 'screenshot-annotator: client resources');
      },
    };
  },
});
