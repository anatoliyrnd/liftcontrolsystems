ужно научить NotificationsPoller понимать, что это первый запуск, и не спамить событиями, а просто зафиксировать текущие версии сервера.

В файле notifications-poller.js в методе _tick найдите блок обработки версий и добавьте проверку isFirstLaunch:

javascript
      // 🚨 ОБРАБОТКА ВЕРСИЙ (ДЕЛЬТА-СИНХРОНИЗАЦИЯ) 🚨
      if (response.versions) {
        const serverVersions = response.versions;
        
        // Проверяем, пустой ли кэш версий (первый запуск)
        const isFirstLaunch = Object.keys(localVersions).length === 0 || localVersions.open_tickets === undefined;

        let shouldFetchOpen = false;
        let shouldFetchAddresses = false;

        if (!isFirstLaunch) {
          // Если это НЕ первый запуск — сравниваем версии
          if ((serverVersions.open_tickets || 0) > (localVersions.open_tickets || 0)) {
            shouldFetchOpen = true;
          }
          if ((serverVersions.addresses || 0) > (localVersions.addresses || 0)) {
            shouldFetchAddresses = true;
          }
        } else {
          console.log("[NotificationsPoller] Первый запуск: базовые версии сохранены, лишние запросы не нужны.");
        }

        // Сохраняем новые версии в любом случае
        this._saveVersions(serverVersions);

        // Кидаем события только если это не первый запуск
        if (!window.syncManagerInstance?.isSyncing && !isFirstLaunch) {
          if (shouldFetchOpen) {
            window.dispatchEvent(new CustomEvent("sync:fetch_open_tickets"));
          }
          if (shouldFetchAddresses) {
            window.dispatchEvent(new CustomEvent("sync:fetch_addresses"));
          }
        }
      }
