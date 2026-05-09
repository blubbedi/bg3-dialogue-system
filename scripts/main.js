const MOD_ID = 'bg3-dialogue-system';

// Debug-Log Helfer
function log(msg) { console.log(`BG3-DIALOG | ${msg}`); }

Hooks.once('init', () => {
    log("Initialisiere Einstellungen...");
    game.settings.register(MOD_ID, 'npcFolder', {
        name: "NPC-Ordner Name",
        scope: "world",
        config: true,
        type: String,
        default: "BG3-Dialogue-NPCs"
    });

    // Helper für die Nummerierung der Antwortmöglichkeiten
    Handlebars.registerHelper('add', function(a, b) {
        return Number(a) + Number(b);
    });
});

Hooks.once('ready', async () => {
    log("Foundry bereit. Prüfe Standard-Ordner...");
    if (game.user.isGM) {
        await BG3DialogueSystem.checkAndCreateDefaults();
    }

    game.socket.on(`module.${MOD_ID}`, data => {
        // 1. Spieler öffnet das Fenster
        if (data.type === "showDialog" && game.user.id === data.receiverId) {
            new BG3DialogueWindow(data.npcId, data.pcId, data.fullTree, data.startNode).render(true);
        } 
        // 2. Nur der *aktive* GM verarbeitet Chat-Nachrichten und Logs
        else if (data.type === "choiceMade" && game.user.isGM && game.users.activeGM?.isSelf) {
            BG3DialogueSystem.processChoice(data);
        } 
        // 3. GM aktualisiert sein Beobachter-Fenster
        else if (data.type === "updateObserver" && game.user.isGM) {
            const openApp = Object.values(ui.windows).find(app => app instanceof BG3DialogueWindow && app.npc.id === data.npcId && app.isObserver);
            if (openApp) {
                openApp.currentNodeKey = data.nextNode;
                openApp.render(true);
            }
        } 
        // 4. GM beendet das Gespräch und speichert das Log
        else if (data.type === "closeObserver" && game.user.isGM && game.users.activeGM?.isSelf) {
            BG3DialogueSystem.endConversation(data.npcId);
        }
    });
});

// Scene Controls: Fügt den Button in das Token-Menü ein
Hooks.on('getSceneControlButtons', (controls) => {
    if (!game.user.isGM) return;
    const tokenControl = controls.find(c => c.name === "token");
    if (tokenControl) {
        tokenControl.tools.push({
            name: "start-bg3-conv",
            title: "BG3 Gespräch starten",
            icon: "fas fa-comments",
            onClick: () => BG3DialogueSystem.showSelectionDialog(),
            button: true
        });
    }
});

class BG3DialogueSystem {
    // Speicher für aktive Gesprächsverläufe (wird nur vom GM verwaltet)
    static activeSessions = {};

    static async checkAndCreateDefaults() {
        const folderName = game.settings.get(MOD_ID, 'npcFolder');
        
        // 1. Actor Ordner erstellen
        let actorFolder = game.folders.find(f => f.name === folderName && f.type === "Actor");
        if (!actorFolder) {
            await Folder.create({ name: folderName, type: "Actor", color: "#c1a35b" });
        }

        // 2. Journal Ordner "Gespräche" erstellen
        let journalFolder = game.folders.find(f => f.name === "Gespräche" && f.type === "JournalEntry");
        if (!journalFolder) {
            await Folder.create({ name: "Gespräche", type: "JournalEntry", color: "#c1a35b" });
        }

        // 3. Basis-Lore Journal erstellen
        let journal = game.journal.getName("lore-info");
        if (!journal) {
            await JournalEntry.create({
                name: "lore-info",
                pages: [{ name: "Welt-Aufzeichnungen", type: "text", text: { content: "Hier Lore eintragen." }}]
            });
        }
    }

    static showSelectionDialog() {
        const folderName = game.settings.get(MOD_ID, 'npcFolder');
        const folder = game.folders.find(f => f.name === folderName && f.type === "Actor");
        if (!folder) return ui.notifications.error(`Ordner '${folderName}' fehlt.`);

        const npcs = game.actors.filter(a => a.folder?.id === folder.id);
        const players = game.users.filter(u => u.active && !u.isGM);

        if (npcs.length === 0) return ui.notifications.warn("Keine NPCs im BG3-Ordner.");
        if (players.length === 0) return ui.notifications.warn("Keine aktiven Spieler online.");

        let npcOptions = npcs.map(n => `<option value="${n.id}">${n.name}</option>`).join("");
        let playerOptions = players.map(p => `<option value="${p.id}">${p.name} (${p.character?.name || "Kein Charakter"})</option>`).join("");

        new Dialog({
            title: "BG3 Konfigurator",
            content: `<form><div class="form-group"><label>NSC:</label><select name="npcId">${npcOptions}</select></div>
                      <div class="form-group"><label>Spieler:</label><select name="playerId">${playerOptions}</select></div></form>`,
            buttons: {
                start: { 
                    label: "Senden", 
                    callback: (html) => this.initiateDialogue(html.find('[name="npcId"]').val(), html.find('[name="playerId"]').val())
                }
            }
        }).render(true);
    }

    static async initiateDialogue(npcId, userId) {
        const npc = game.actors.get(npcId);
        const user = game.users.get(userId);
        const pc = user?.character;
        const pcId = pc ? pc.id : null;
        
        // HTML-Säuberung, um pures JSON zu erhalten
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = npc.system.details.biography.value || "";
        const rawJson = (tempDiv.textContent || tempDiv.innerText || "").trim();
        
        try {
            const fullTree = JSON.parse(rawJson);
            const startText = fullTree.startNode.text;

            // Session für das Log-Protokoll starten
            this.activeSessions[npcId] = {
                pcId: pcId,
                userId: userId, // Wird für die Berechtigungen am Ende benötigt
                history: [`<b>${npc.name}:</b> ${startText}`]
            };

            // Begrüßung in den Chat posten
            ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: npc }),
                content: `<div class="bg3-chat-msg npc-msg"><b>${npc.name}:</b> ${startText}</div>`
            });

            // Signal an Spieler senden
            game.socket.emit(`module.${MOD_ID}`, {
                type: "showDialog",
                npcId: npcId,
                pcId: pcId,
                receiverId: userId,
                fullTree: fullTree,
                startNode: "startNode"
            });
            
            // Beobachter-Fenster für GM öffnen
            new BG3DialogueWindow(npcId, pcId, fullTree, "startNode", true).render(true);
        } catch (e) {
            console.error(e);
            ui.notifications.error("Die Biografie enthält kein valides JSON.");
        }
    }

    static processChoice(data) {
        const npc = game.actors.get(data.npcId);
        const pc = data.pcId ? game.actors.get(data.pcId) : null;
        const speakerName = pc ? pc.name : (game.users.get(data.playerId)?.name || "Unbekannt");
        
        // Session-Verlauf aktualisieren
        if (this.activeSessions[data.npcId]) {
            this.activeSessions[data.npcId].history.push(`<b>${speakerName}:</b> ${data.text}`);
            if (data.nextNodeText) {
                this.activeSessions[data.npcId].history.push(`<b>${npc.name}:</b> ${data.nextNodeText}`);
            }
        }

        // Spieler-Antwort im Chat
        ChatMessage.create({
            speaker: pc ? ChatMessage.getSpeaker({ actor: pc }) : { alias: speakerName },
            content: `<div class="bg3-chat-msg pc-msg"><b>${speakerName}:</b> ${data.text}</div>`
        });

        // Nächste NPC-Antwort im Chat
        if (data.nextNodeText) {
            ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: npc }),
                content: `<div class="bg3-chat-msg npc-msg"><b>${npc.name}:</b> ${data.nextNodeText}</div>`
            });
        }
    }

    static async endConversation(npcId) {
        const session = this.activeSessions[npcId];
        if (session) {
            const npc = game.actors.get(npcId);
            const pc = session.pcId ? game.actors.get(session.pcId) : null;
            
            // Formatierung von Datum und Uhrzeit
            const date = new Date().toLocaleDateString("de-DE", { 
                day: '2-digit', month: '2-digit', year: 'numeric', 
                hour: '2-digit', minute: '2-digit' 
            });
            
            const partners = `${npc.name} & ${pc ? pc.name : "Unbekannt"}`;
            const folder = game.folders.find(f => f.name === "Gespräche" && f.type === "JournalEntry");

            // Berechtigungen vergeben: GM hat Vollzugriff, der beteiligte Spieler bekommt Leserechte
            let permissions = { default: 0 }; 
            if (session.userId) {
                permissions[session.userId] = 2; // 2 = Observer / Beobachter
            }

            // Journal in Foundry anlegen
            await JournalEntry.create({
                name: `${partners} (${date})`,
                folder: folder?.id,
                ownership: permissions,
                pages: [{
                    name: "Gesprächsprotokoll",
                    type: "text",
                    text: { content: session.history.map(line => `<p style="margin-bottom: 5px;">${line}</p>`).join("") }
                }]
            });

            // Session aus dem Speicher löschen
            delete this.activeSessions[npcId];
        }

        // Beobachter-Fenster des GMs schließen
        const openApp = Object.values(ui.windows).find(app => app instanceof BG3DialogueWindow && app.npc.id === npcId && app.isObserver);
        if (openApp) openApp.close();
    }
}

class BG3DialogueWindow extends Application {
    constructor(npcId, pcId, fullTree, currentNodeKey, isObserver = false) {
        super();
        this.npc = game.actors.get(npcId);
        this.pc = pcId ? game.actors.get(pcId) : null;
        this.fullTree = fullTree;
        this.currentNodeKey = currentNodeKey;
        this.isObserver = isObserver;
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "bg3-dialog-ui",
            template: `modules/${MOD_ID}/templates/dialog.html`,
            width: 700,
            height: "auto",
            popOut: true,
            title: "Gespräch"
        });
    }

    getData() {
        const node = this.fullTree[this.currentNodeKey];
        return {
            npcName: this.npc.name,
            npcImg: this.npc.img,
            pcName: this.pc ? this.pc.name : null,
            pcImg: this.pc ? this.pc.img : null,
            text: node ? node.text : "...",
            options: node && node.options ? node.options : [],
            isObserver: this.isObserver
        };
    }

    activateListeners(html) {
        super.activateListeners(html);
        html.find('.dialog-option').click(ev => {
            if (this.isObserver) return; // Klick für GM blockieren
            
            const idx = $(ev.currentTarget).data('index');
            const node = this.fullTree[this.currentNodeKey];
            const selected = node.options[idx];
            const nextNode = selected.nextNode ? this.fullTree[selected.nextNode] : null;
            
            // Auswahl über Socket an GM senden
            game.socket.emit(`module.${MOD_ID}`, {
                type: "choiceMade",
                npcId: this.npc.id,
                pcId: this.pc ? this.pc.id : null,
                playerId: game.user.id,
                text: selected.text,
                nextNodeText: nextNode ? nextNode.text : null
            });

            // Dialog weiterführen oder beenden
            if (nextNode) {
                this.currentNodeKey = selected.nextNode;
                this.render(true);
                game.socket.emit(`module.${MOD_ID}`, { type: "updateObserver", npcId: this.npc.id, nextNode: selected.nextNode });
            } else {
                game.socket.emit(`module.${MOD_ID}`, { type: "closeObserver", npcId: this.npc.id });
                this.close();
            }
        });
    }
}