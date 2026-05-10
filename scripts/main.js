const MOD_ID = 'bg3-dialogue-system';

function log(msg) { console.log(`BG3-DIALOG | ${msg}`); }

Hooks.once('init', () => {
    game.settings.register(MOD_ID, 'npcFolder', {
        name: "NPC-Ordner Name",
        scope: "world",
        config: true,
        type: String,
        default: "BG3-Dialogue-NPCs"
    });

    Handlebars.registerHelper('add', function(a, b) {
        return Number(a) + Number(b);
    });
});

Hooks.once('ready', async () => {
    if (game.user.isGM) {
        await BG3DialogueSystem.checkAndCreateDefaults();
    }

    game.socket.on(`module.${MOD_ID}`, data => {
        if (data.type === "showDialog" && game.user.id === data.receiverId) {
            new BG3DialogueWindow(data.npcId, data.pcId, data.fullTree, data.startNode).render(true);
        } 
        else if (data.type === "choiceMade" && game.user.isGM && game.users.activeGM?.isSelf) {
            BG3DialogueSystem.processChoice(data);
        } 
        else if (data.type === "updateObserver" && game.user.isGM) {
            const openApp = Object.values(ui.windows).find(app => app instanceof BG3DialogueWindow && app.npc.id === data.npcId && app.isObserver);
            if (openApp) {
                openApp.currentNodeKey = data.nextNode;
                openApp.render(true);
            }
        } 
        else if (data.type === "closeObserver" && game.user.isGM && game.users.activeGM?.isSelf) {
            BG3DialogueSystem.endConversation(data.npcId);
        }
    });
});

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
    static activeSessions = {};

    static async checkAndCreateDefaults() {
        const folderName = game.settings.get(MOD_ID, 'npcFolder');
        
        let actorFolder = game.folders.find(f => f.name === folderName && f.type === "Actor");
        if (!actorFolder) await Folder.create({ name: folderName, type: "Actor", color: "#c1a35b" });

        let journalFolder = game.folders.find(f => f.name === "Gespräche" && f.type === "JournalEntry");
        if (!journalFolder) await Folder.create({ name: "Gespräche", type: "JournalEntry", color: "#c1a35b" });
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
        
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = npc.system.details.biography.value || "";
        const rawJson = (tempDiv.textContent || tempDiv.innerText || "").trim();
        
        try {
            const fullTree = JSON.parse(rawJson);
            const startText = fullTree.startNode.text;

            this.activeSessions[npcId] = {
                pcId: pcId,
                userId: userId,
                history: [`<b>${npc.name}:</b> ${startText}`]
            };

            ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: npc }),
                content: `<div class="bg3-chat-msg npc-msg"><b>${npc.name}:</b> ${startText}</div>`
            });

            game.socket.emit(`module.${MOD_ID}`, {
                type: "showDialog", npcId: npcId, pcId: pcId, receiverId: userId,
                fullTree: fullTree, startNode: "startNode"
            });
            
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
        
        if (this.activeSessions[data.npcId]) {
            this.activeSessions[data.npcId].history.push(`<b>${speakerName}:</b> ${data.text}`);
            if (data.nextNodeText) {
                this.activeSessions[data.npcId].history.push(`<b>${npc.name}:</b> ${data.nextNodeText}`);
            }
        }

        ChatMessage.create({
            speaker: pc ? ChatMessage.getSpeaker({ actor: pc }) : { alias: speakerName },
            content: `<div class="bg3-chat-msg pc-msg"><b>${speakerName}:</b> ${data.text}</div>`
        });

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
            
            const date = new Date().toLocaleDateString("de-DE", { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            const partners = `${npc.name} & ${pc ? pc.name : "Unbekannt"}`;
            const folder = game.folders.find(f => f.name === "Gespräche" && f.type === "JournalEntry");

            let permissions = { default: 0 }; 
            if (session.userId) permissions[session.userId] = 2;

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

            delete this.activeSessions[npcId];
        }

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
        
        // Bonus aus dem Charakterbogen lesen und in den Text injizieren
        const options = (node && node.options ? node.options : []).map(opt => {
            let displayHtml = opt.text;
            if (opt.check && this.pc) {
                const skill = this.pc.system.skills[opt.check];
                const mod = skill ? skill.total : 0;
                const modStr = mod >= 0 ? `+${mod}` : `${mod}`;
                // Sucht nach Text in eckigen Klammern und hängt den Bonus an (z.B. [Überzeugen] -> [Überzeugen +5])
                displayHtml = opt.text.replace(/\[(.*?)\]/, `[$1 ${modStr}]`);
            }
            return { ...opt, displayHtml };
        });
        
        return {
            npcName: this.npc.name,
            npcImg: this.npc.img,
            pcName: this.pc ? this.pc.name : null,
            pcImg: this.pc ? this.pc.img : null,
            text: node ? node.text : "...",
            options: options,
            isEndNode: options.length === 0,
            isObserver: this.isObserver
        };
    }

    activateListeners(html) {
        super.activateListeners(html);
        
        html.find('.dialog-option').click(async ev => {
            if (this.isObserver) return;
            
            const idx = $(ev.currentTarget).data('index');
            const node = this.fullTree[this.currentNodeKey];
            const selected = node.options[idx];
            
            let nextNodeKey = selected.nextNode;
            let chatText = selected.text;
            let rollResultText = "";

            // --- SKILL CHECK LOGIK ---
            if (selected.check) {
                if (!this.pc) {
                    return ui.notifications.warn("Für diese Aktion muss ein Spieler-Charakter (PC) ausgewählt sein!");
                }
                
                const skill = this.pc.system.skills[selected.check];
                const mod = skill ? skill.total : 0;
                const modStr = mod >= 0 ? `+${mod}` : `${mod}`;
                
                // Formatiert den Text für den Chat sauber
                chatText = selected.text.replace(/\[(.*?)\]/, `[$1 ${modStr}]`);

                // Würfeln (1d20 + Modifikator)
                const roll = await new Roll(`1d20 + ${mod}`).evaluate();
                
                // 3D Würfel anzeigen, falls das Modul installiert ist
                if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true);

                // Ergebnis prüfen
                const isSuccess = roll.total >= selected.dc;
                nextNodeKey = isSuccess ? selected.passNode : selected.failNode;
                
                // Text für das Journal/Chat Log vorbereiten
                const resultStr = isSuccess ? "ERFOLG" : "FEHLSCHLAG";
                const resultColor = isSuccess ? "#4db8ff" : "#ff4d4d"; // Blau oder Rot
                rollResultText = `<br><span style="color: ${resultColor}; font-size: 0.85em; font-style: normal;">↳ [Wurf: ${roll.total} vs SG ${selected.dc} ➔ <b>${resultStr}</b>]</span>`;

                // Echten Wurf in den Chat posten
                const skillLabel = CONFIG.DND5E.skills[selected.check]?.label || selected.check.toUpperCase();
                await roll.toMessage({
                    speaker: ChatMessage.getSpeaker({ actor: this.pc }),
                    flavor: `Fertigkeitswurf: ${skillLabel} (SG ${selected.dc})`
                });
            }

            // Senden an den GM
            game.socket.emit(`module.${MOD_ID}`, {
                type: "choiceMade",
                npcId: this.npc.id,
                pcId: this.pc ? this.pc.id : null,
                playerId: game.user.id,
                text: chatText + rollResultText,
                nextNodeText: (nextNodeKey && this.fullTree[nextNodeKey]) ? this.fullTree[nextNodeKey].text : null
            });

            // Fenster updaten oder schließen
            if (nextNodeKey && this.fullTree[nextNodeKey]) {
                this.currentNodeKey = nextNodeKey;
                this.render(true);
                game.socket.emit(`module.${MOD_ID}`, { type: "updateObserver", npcId: this.npc.id, nextNode: nextNodeKey });
            } else {
                game.socket.emit(`module.${MOD_ID}`, { type: "closeObserver", npcId: this.npc.id });
                this.close();
            }
        });

        html.find('.dialog-close-btn').click(ev => {
            if (this.isObserver) return;
            game.socket.emit(`module.${MOD_ID}`, {
                type: "choiceMade",
                npcId: this.npc.id,
                pcId: this.pc ? this.pc.id : null,
                playerId: game.user.id,
                text: "<i>*Verlässt das Gespräch*</i>",
                nextNodeText: null
            });
            game.socket.emit(`module.${MOD_ID}`, { type: "closeObserver", npcId: this.npc.id });
            this.close();
        });
    }
}