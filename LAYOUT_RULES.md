# Правила верстки и адаптивности для мобильных игр (Android TWA / WebView / PWA)

Этот документ фиксирует причину бага обрезания интерфейса на устройствах вроде Samsung Galaxy S10, найденное решение и обязательный стандарт для всех существующих и новых игр в проекте.

---

## 1. Что случилось (Описание бага)

### Симптомы:
* При запуске игры в приложении (TWA / WebView в ландшафтной ориентации) на устройствах уровня Galaxy S10 (Android 12) **обрезался низ экрана**: нижняя рамка игрового поля срезалась, а тени и нижние элементы интерфейса уходили за пределы экрана.
* При свайпе снизу вверх (вызов системной навигационной панели Android) и после её исчезновения через пару секунд интерфейс внезапно вставал на место.
* На более новых устройствах (например, Galaxy S25 / Android 15) всё работало корректно сразу.

### Причина:
1. **Некорректный расчёт `100dvh` и `100vh` при «холодном» старте:**  
   В режиме TWA полноэкранный режим (*immersive fullscreen*) скрывает статус-бар и софт-панель навигации. На Android 11–12 движок Chromium инициализирует страницу до того, как система окончательно фиксирует геометрию без полос. В результате `100dvh` и `100vh` кэшируют завышенный размер (на 20–45px больше реального видимого окна).
2. **Механика «исцеления» при свайпе:**  
   Когда пользователь вызывал панель жестом, Android слал событие `onApplyWindowInsets`, что вызывало в браузере принудительный `window.resize`. Когда панель скрывалась — происходил ещё один `resize`, и Chromium на лету пересчитывал `100dvh` уже правильно.
3. **Ошибочный `max-height` внутри карточек:**  
   Использование конструкций вроде `max-height: calc(100dvh - 80px)` транслировало ошибочную высоту внутрь flexbox-детей.
4. **Неучтённая нижняя тень (`box-shadow`):**  
   CSS-свойство `box-shadow: 0 6px 0 var(--ink)` выступает строго наружу и не включается в расчёт `box-sizing: border-box`. Если у родителя не было нижнего запаса (padding/margin), тень вылезала за границы видимости.

---

## 2. Архитектурное решение

1. **Полный запрет `100dvh` и `100vh` в основном лейауте:**  
   Вместо динамических единиц высоты используется жесткая привязка к физическому viewport через `position: fixed; inset: 0;`.
2. **Синтаксис `max(env(safe-area-inset-*), Npx)` с обязательным фоллбэком:**  
   Внутри `env(...)` **всегда** должен быть указан fallback `0px` (`env(safe-area-inset-bottom, 0px)`). Без него в ряде браузеров функция `max(...)` становится невалидным CSS-свойством.
3. **Контроль flex-сжатия и тени:**  
   Все игровые контейнеры внутри `#app` должны иметь `min-height: 0;` (чтобы flexbox мог сжимать их по высоте) и явный нижний отступ (`padding-bottom: 8px` или `10px`), полностью перекрывающий высоту внешней тени элементов.

---

## 3. Золотой стандарт для новых игр (Checklist & Шаблон)

### HTML `<head>`
Обязателен параметр `viewport-fit=cover`:
```html
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
```

### CSS: База страницы и контейнер `#app`
```css
* {
  box-sizing: border-box;
  -webkit-tap-highlight-color: transparent;
  margin: 0;
  padding: 0;
}

html, body {
  width: 100%;
  height: 100%;
  min-height: 100%;
  overflow: hidden;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}

#app {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  box-sizing: border-box;
  overflow: hidden;

  /* Безопасные отступы под вырезы камеры и навигационную панель */
  padding-top: max(env(safe-area-inset-top, 0px), 6px);
  padding-bottom: max(env(safe-area-inset-bottom, 0px), 8px);
  padding-left: max(env(safe-area-inset-left, 0px), 12px);
  padding-right: max(env(safe-area-inset-right, 0px), 12px);
}
```

### CSS: Центральное игровое поле (Arena / Game Area)
```css
.arena {
  flex: 1;
  width: 100%;
  max-width: 960px;
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: center;
  min-height: 0; /* ОБЯЗАТЕЛЬНО: разрешает flex-элементу уменьшаться */
  padding: 4px 0 8px 0; /* ОБЯЗАТЕЛЬНО: нижний запас под тени карточек */
}

.game-card {
  height: 100%;
  max-height: 100%; /* ЗАПРЕЩЕНО: calc(100vh - ...) или calc(100dvh - ...) */
  min-height: 0;    /* ОБЯЗАТЕЛЬНО */
  box-sizing: border-box;
  box-shadow: 0 6px 0 var(--ink);
  overflow: hidden;
}
```

---

## 4. Памятка по кэшированию и Service Worker (`sw.js`)

* В проекте используется стратегия **Network-First** («Сначала сеть»).
* **При правках CSS/JS существующих игр:** менять версию кэша в `sw.js` **не нужно**. Если на телефоне есть интернет, браузер автоматически запрашивает актуальный файл с GitHub Pages и сам обновляет кэш.
* **Версию кэша (`CACHE_NAME` в `sw.js`) менять ОБЯЗАТЕЛЬНО ТОЛЬКО когда:**
  1. Добавлена новая игра или новые ассеты (звуки, текстуры, 3D-модели), прописанные в массив `PRECACHE_URLS`. Без смены `sw.js` браузер не запустит событие `install` и не скачает их для офлайн-режима.
  2. Удалены старые ассеты (для автоматической очистки памяти устройства в событии `activate`).
