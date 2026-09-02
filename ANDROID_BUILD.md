# Сборка Android-приложения (TWA) через GitHub Actions

Что это: приложение — это тонкая оболочка (Trusted Web Activity), которая
открывает https://ssadovsky.github.io/kids-games/ внутри Chrome в полноэкранном
режиме. Контент игр не зашит в apk/aab — значит, любой коммит в GitHub Pages
сразу виден в уже установленном приложении, пересобирать apk/aab для этого
не нужно. Пересборка нужна только если меняются: иконка, название, package id
или сам файл twa-manifest.json/manifest.json.

## Что нужно один раз сделать в настройках GitHub-репозитория

Settings → Secrets and variables → Actions → New repository secret.
Добавить три секрета (значения — в файле SECRETS_DO_NOT_COMMIT/README.txt,
он НЕ в гите, только у тебя локально):

- `ANDROID_KEYSTORE_BASE64` — содержимое файла
  `SECRETS_DO_NOT_COMMIT/android-upload.keystore.b64.txt` (одна длинная строка).
- `BUBBLEWRAP_KEYSTORE_PASSWORD` — пароль из README.txt.
- `BUBBLEWRAP_KEY_PASSWORD` — тот же самый пароль (см. README.txt почему).

Больше ничего в Settings трогать не нужно.

## Digital Asset Links — важный отдельный шаг

Чтобы приложение открывалось БЕЗ строки адреса Chrome (выглядело как настоящее
приложение, а не как браузер), Google должен убедиться, что именно ты владеешь
и сайтом, и приложением. Для этого на домене `ssadovsky.github.io` (в его
КОРНЕ, не внутри /kids-games/) должен быть доступен файл:

    https://ssadovsky.github.io/.well-known/assetlinks.json

Сейчас `https://ssadovsky.github.io/` отдаёт 404 — под этим доменом нет
отдельного репозитория `ssadovsky.github.io`, публикующего корень. Файл
`.well-known/assetlinks.json` с нужным содержимым уже лежит в этом репозитории
(kids-games), но это не то место — GitHub Pages отдаёт его по адресу
`.../kids-games/.well-known/assetlinks.json`, а нужен именно корень домена.

Варианты:
1. Создать отдельный репозиторий с названием ровно `ssadovsky.github.io`,
   включить в нём GitHub Pages, и положить туда файл `.well-known/assetlinks.json`
   с тем же содержимым, что лежит здесь в `kids-games/.well-known/assetlinks.json`.
2. Или не делать этого сейчас — приложение всё равно будет собираться и
   работать, просто Chrome будет показывать сверху адресную строку (менее
   "нативно" выглядит, но функционально всё ок). Добавить assetlinks.json
   можно в любой момент позже, без пересборки — Chrome перепроверяет его
   на лету при запуске приложения.

После первой публикации в Google Play Console у Google появится ещё один,
СВОЙ сертификат подписи (Play App Signing) — его SHA256-отпечаток тоже нужно
будет добавить вторым объектом в assetlinks.json (взять в Play Console →
Setup → App integrity). Без этого шага после публикации в Play строка адреса
может вернуться даже если раньше всё работало.

## Как собрать

Actions → "Build Android app (TWA / Bubblewrap)" → Run workflow (кнопка
справа), либо сборка запускается сама при коммите, который меняет
twa-manifest.json / manifest.json. Готовые `app-release-bundle.aab` (для
Play Console) и `app-release-signed.apk` (для ручной установки/теста на
телефоне) появятся в Actions → в конкретном запуске → Artifacts, внизу
страницы, архивом для скачивания.

## Первая загрузка в Google Play Console

Нужен аккаунт разработчика (разовый взнос $25). В Play Console создаётся
приложение, загружается `app-release-bundle.aab`. Package id уже зашит в
проект: `com.ssadovsky.kidsgames` — его нельзя будет поменять после первой
публикации, если хочешь другой — поменяй `packageId` в `twa-manifest.json`
ДО первой загрузки в Play Console.

## Если нужно поменять иконку/название/цвета

Меняешь `manifest.json` (для самого сайта/PWA) и/или `twa-manifest.json`
(для сборки приложения) и файлы icon-*.png, коммитишь — сборка в Actions
подхватит изменения автоматически (или запускаешь Run workflow вручную).
