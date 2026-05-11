const MOD_ID = 'bg3-dialogue-system';

function log(msg) { console.log(`BG3-DIALOG | ${msg}`); }

// Weiche für GM-Events (Permission-Safe für Spieler)
function dispatchSystemEvent(data) {
    if (game.user.isGM) {
        if (data.type === "choiceMade") BG3DialogueSystem.processChoice(data);
        else if (data.type === "closeObserver") BG3DialogueSystem.endConversation(data.npcId);
        else if (data.type === "updateRelationship") BG3DialogueSystem.updateRelationshipJournal(data.npcId, data.mod, data.tag);
    } else {
        game.socket.emit(`module.${MOD_ID}`, data);
    }
}

Hooks.once('init', () => {
    game.settings.register(MOD_ID, 'npcFolder', {
        name: "NPC-Ordner Name", scope: "world", config: true, type: String, default: "BG3-Dialogue-NPCs"
    });
    Handlebars.registerHelper('add', (a, b) => Number(a) + Number(b));
});

Hooks.once('ready', async () => {
    if (game.user.isGM) await BG3DialogueSystem.checkAndCreateDefaults();

    game.socket.on(`module.${MOD_ID}`, async data => {
        if (data.type === "showDialog" && game.user.id === data.receiverId) {
            new BG3DialogueWindow(data.npcId, data.pcId, data.fullTree, data.startNode, false, data.relScore, data.relTags).render(true);
        } else if (data.type === "choiceMade" && game.user.isGM) {
            await BG3DialogueSystem.processChoice(data);
        } else if (data.type === "updateObserver" && game.user.isGM) {
            const app = Object.values(ui.windows).find(a => a instanceof BG3DialogueWindow && a.npc.id === data.npcId && a.isObserver);
            if (app) { 
                app.currentNodeKey = data.nextNode; 
                app.relScore = data.relScore; 
                app.relTags = data.relTags; 
                app.render(true); 
            }
        } else if (data.type === "closeObserver" && game.user.isGM) {
            await BG3DialogueSystem.endConversation(data.npcId);
        } else if (data.type === "updateRelationship" && game.user.isGM) {
            await BG3DialogueSystem.updateRelationshipJournal(data.npcId, data.mod, data.tag);
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
        let parent = game.folders.find(f => f.name === "Gespräche" && f.type === "JournalEntry") || await Folder.create({ name: "Gespräche", type: "JournalEntry" });
        if (!game.folders.find(f => f.name === "Beziehung" && f.folder?.id === parent.id)) await Folder.create({ name: "Beziehung", type: "JournalEntry", folder: parent.id });
        if (!game.folders.find(f => f.name === "Logs" && f.folder?.id === parent.id)) await Folder.create({ name: "Logs", type: "JournalEntry", folder: parent.id });
    }

    static async getOrCreateRelationship(npcName) {
        let relFolder = game.folders.find(f => f.name === "Beziehung" && f.type === "JournalEntry");
        let report = game.journal.find(j => j.name === npcName && j.folder?.id === relFolder?.id);
        if (!report) {
            report = await JournalEntry.create({ name: npcName, folder: relFolder?.id, pages: [{ name: "Status", type: "text", text: { content: "..." } }] });
            await report.setFlag(MOD_ID, "relationshipScore", 0);
            await report.setFlag(MOD_ID, "tags", []);
        }
        return { score: report.getFlag(MOD_ID, "relationshipScore") || 0, tags: report.getFlag(MOD_ID, "tags") || [], report: report };
    }

    static async updateRelationshipJournal(npcId, adjustment = 0, tag = null) {
        const npc = game.actors.get(npcId);
        if(!npc) return;
        const rel = await this.getOrCreateRelationship(npc.name);
        let newScore = (rel.score || 0) + adjustment;
        let newTags = [...rel.tags];
        if (tag && !newTags.includes(tag)) newTags.push(tag);
        
        await rel.report.setFlag(MOD_ID, "relationshipScore", newScore);
        await rel.report.setFlag(MOD_ID, "tags", newTags);
        
        const status = newScore >= 5 ? "Freundlich" : (newScore <= -5 ? "Feindlich" : "Neutral");
        const page = rel.report.pages.contents[0];
        if(page) {
            await page.update({ "text.content": `<h3>Status: ${npc.name}</h3><p>Stimmung: ${newScore} (${status})</p><ul>${newTags.map(t => `<li>${t}</li>`).join("")}</ul>` });
        }
        return { score: newScore, tags: newTags };
    }

    static showSelectionDialog() {
        const folderName = game.settings.get(MOD_ID, 'npcFolder');
        const folder = game.folders.find(f => f.type === "Actor" && f.name === folderName);
        if (!folder) return ui.notifications.error(`Ordner '${folderName}' nicht gefunden.`);
        const npcs = game.actors.filter(a => a.folder?.id === folder.id);
        const players = game.users.filter(u => u.active && !u.isGM);

        let npcOptions = npcs.map(n => `<option value="${n.id}">${n.name}</option>`).join("");
        let playerOptions = `<option value="${game.user.id}">GM / Test-Modus</option>`;
        playerOptions += players.map(p => `<option value="${p.id}">${p.name} (${p.character?.name || "Kein Charakter"})</option>`).join("");

        new Dialog({
            title: "BG3 Konfigurator",
            content: `<form><div class="form-group"><label>NSC:</label><select name="npcId">${npcOptions}</select></div>
                      <div class="form-group"><label>Spieler:</label><select name="playerId">${playerOptions}</select></div></form>`,
            buttons: {
                start: { label: "Senden", callback: (html) => this.initiateDialogue(html.find('[name="npcId"]').val(), html.find('[name="playerId"]').val()) }
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
            const relData = await this.getOrCreateRelationship(npc.name);
            this.activeSessions[npcId] = { pcId: pcId, pcName: pc?.name || user.name, userId: userId, history: [`<b>${npc.name}:</b> ${fullTree.startNode.text}`] };

            if (userId === game.user.id) {
                new BG3DialogueWindow(npcId, pcId, fullTree, "startNode", false, relData.score, relData.tags).render(true);
            } else {
                game.socket.emit(`module.${MOD_ID}`, { type: "showDialog", npcId, pcId, receiverId: userId, fullTree, startNode: "startNode", relScore: relData.score, relTags: relData.tags });
                new BG3DialogueWindow(npcId, pcId, fullTree, "startNode", true, relData.score, relData.tags).render(true);
            }
        } catch (e) { ui.notifications.error("JSON fehlerhaft."); }
    }

    static async processChoice(data) {
        const session = this.activeSessions[data.npcId];
        if (!session) return;
        session.history.push(`<b>${data.speaker}:</b> ${data.text}`);
        
        if (data.systemLog) session.history.push(`<span style="color: #8b0000; font-size: 0.9em;"><i>${data.systemLog}</i></span>`);
        if (data.nextNodeText) session.history.push(`<b>${game.actors.get(data.npcId).name}:</b> ${data.nextNodeText}`);
        
        ChatMessage.create({ speaker: { alias: data.speaker }, content: `<div class="bg3-chat-msg pc-msg"><b>${data.speaker}:</b> ${data.text}</div>` });
        if (data.nextNodeText) ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: game.actors.get(data.npcId) }), content: `<div class="bg3-chat-msg npc-msg"><b>${game.actors.get(data.npcId).name}:</b> ${data.nextNodeText}</div>` });
    }

    static async endConversation(npcId) {
        const session = this.activeSessions[npcId];
        if (!session) return;
        
        const logTitle = `${game.actors.get(npcId).name} & ${session.pcName}`;
        let logsFolder = game.folders.find(f => f.name === "Logs");
        let logEntry = game.journal.find(j => j.name === logTitle && j.folder?.id === logsFolder?.id);
        const newContent = `<hr><h3>${new Date().toLocaleString()}</h3>` + session.history.map(h => `<p>${h}</p>`).join("");
        
        // Berechtigungen setzen (2 = Observer/Lesezugriff)
        let permissions = { default: 0 };
        if (session.userId) permissions[session.userId] = 2;

        if (logEntry) {
            let page = logEntry.pages.contents[0];
            await page.update({ "text.content": (page.text.content || "") + newContent });
            
            // Wenn der Eintrag schon existiert, stellen wir sicher, dass der Spieler die Leserechte auch behält
            let currentOwnership = logEntry.ownership || {};
            if (session.userId && currentOwnership[session.userId] !== 2 && currentOwnership[session.userId] !== 3) {
                currentOwnership[session.userId] = 2;
                await logEntry.update({ ownership: currentOwnership });
            }
        } else {
            await JournalEntry.create({ 
                name: logTitle, 
                folder: logsFolder?.id, 
                ownership: permissions, // Hier geben wir dem Spieler sofort den Lesezugriff
                pages: [{ name: "Protokoll", type: "text", text: { content: newContent } }] 
            });
        }
        delete this.activeSessions[npcId];
    }
}

class BG3DialogueWindow extends Application {
    constructor(npcId, pcId, fullTree, currentNodeKey, isObserver = false, relScore = 0, relTags = []) {
        super();
        this.npc = game.actors.get(npcId);
        this.pc = pcId ? game.actors.get(pcId) : null;
        this.fullTree = fullTree;
        this.currentNodeKey = currentNodeKey;
        this.isObserver = isObserver;
        this.relScore = relScore;
        this.relTags = relTags;
        this.insightResults = {};
        this.processedNodes = new Set(); // Verhindert doppelte Ausführung bei UI-Rerenders
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, { 
            id: "bg3-dialog-ui", template: "modules/bg3-dialogue-system/templates/dialog.html", width: 700, height: "auto"
        });
    }

    async render(force, options) {
        if (!this.isObserver && force) {
            const node = this.fullTree[this.currentNodeKey];
            if (node && !this.processedNodes.has(this.currentNodeKey)) {
                this.processedNodes.add(this.currentNodeKey);
                
                // UI lokal sofort updaten
                if (node.ship_mod) this.relScore += node.ship_mod;
                if (node.ship_tag && !this.relTags.includes(node.ship_tag)) this.relTags.push(node.ship_tag);

                if (node.ship_mod > 0) ui.notifications.info(`Die Stimmung von ${this.npc.name} bessert sich.`);
                else if (node.ship_mod < 0) ui.notifications.warn(`Die Stimmung von ${this.npc.name} verschlechtert sich!`);

                // Datenbank-Schreibvorgang an GM delegieren
                if (node.ship_mod || node.ship_tag) {
                    dispatchSystemEvent({ type: "updateRelationship", npcId: this.npc.id, mod: node.ship_mod || 0, tag: node.ship_tag });
                }
                await this._handleReactiveInsight(node);
            }
        }
        return super.render(force, options);
    }

    async _handleReactiveInsight(node) {
        if (node.reactive_check && this.insightResults[this.currentNodeKey] === undefined) {
            let roll = await new Roll("1d20").evaluate();
            let d20 = roll.total;

            if (d20 === 1 && this._isHalfling()) {
                roll = await new Roll("1d20").evaluate();
                d20 = roll.total;
            }

            const bonus = this.pc ? (this.pc.system.skills[node.reactive_check.skill]?.total || 0) : 0;
            const success = (d20 + bonus) >= (node.reactive_check.dc + this._getDCMod());
            this.insightResults[this.currentNodeKey] = success;
            
            if (success && node.reactive_check.ship_tag) {
                dispatchSystemEvent({ type: "updateRelationship", npcId: this.npc.id, mod: 0, tag: node.reactive_check.ship_tag });
                if (!this.relTags.includes(node.reactive_check.ship_tag)) this.relTags.push(node.reactive_check.ship_tag);
            }
        }
    }

    _getDCMod() { return this.relScore <= -5 ? 5 : (this.relScore < 0 ? 2 : (this.relScore >= 5 ? -5 : (this.relScore > 0 ? -2 : 0))); }

    _isHalfling() {
        if (!this.pc) return false;
        const raceItem = this.pc.items.find(i => i.type === "race");
        const raceStr = raceItem ? raceItem.name.toLowerCase() : (this.pc.system.details.race?.toLowerCase() || "");
        return raceStr.includes("halbling") || raceStr.includes("halfling");
    }

    getData() {
        const node = this.fullTree[this.currentNodeKey];
        const opts = (node?.options || []).filter(o => !o.condition_tag || this.relTags.includes(o.condition_tag)).map(o => {
            let txt = o.text;
            if (o.check && this.pc) {
                const bonus = this.pc.system.skills[o.check].total;
                txt = txt.replace(/\[(.*?)\]/, `[$1 ${bonus >= 0 ? '+' : ''}${bonus}]`);
            }
            return { ...o, displayHtml: txt };
        });
        return { 
            npcName: this.npc.name, npcImg: this.npc.img, pcImg: this.pc?.img, pcName: this.pc?.name, text: node?.text, options: opts, 
            relationshipStatus: { class: this.relScore >= 5 ? "friendly" : (this.relScore <= -5 ? "hostile" : "neutral") },
            showInsight: this.insightResults[this.currentNodeKey], insightText: node?.reactive_check?.success_text, hasInspiration: this.pc?.system.attributes.inspiration
        };
    }

    activateListeners(html) {
        super.activateListeners(html);
        html.find('.dialog-option').click(async ev => {
            if (this.isObserver) return;
            const idx = $(ev.currentTarget).data('index');
            const opt = this.fullTree[this.currentNodeKey].options[idx];
            let nextKey = opt.nextNode, resTxt = "", speaker = this.pc?.name || game.user.name;

            if (opt.check && this.pc) {
                let roll = await new Roll("1d20").evaluate();
                let d20 = roll.total;
                
                // Halblingsglück
                if (d20 === 1 && this._isHalfling()) {
                    ui.notifications.info("🍀 Halblingsglück! Die 1 wird neu gewürfelt.");
                    roll = await new Roll("1d20").evaluate();
                    d20 = roll.total;
                }

                const bonus = this.pc.system.skills[opt.check].total;
                let total = d20 + bonus;
                const finalDC = opt.dc + this._getDCMod();

                // Inspiration
                const useInspiration = html.find('#use-inspiration').is(':checked');
                if (total < finalDC && useInspiration && this.pc.system.attributes.inspiration) {
                    ui.notifications.warn("✨ Inspiration verbraucht! Schicksal wendet sich...");
                    await this.pc.update({"system.attributes.inspiration": false});
                    roll = await new Roll("1d20").evaluate();
                    d20 = roll.total;
                    total = d20 + bonus;
                }

                if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true);

                const success = total >= finalDC;
                nextKey = success ? opt.passNode : opt.failNode;
                
                // Gesamtergebnis anzeigen, damit die Mathe stimmt
                const resultColor = success ? "#4db8ff" : "#ff4d4d";
                resTxt = `<br><span style="color: ${resultColor}; font-size: 0.85em;">↳ [Wurf: ${total} (W20: ${d20}) vs SG ${finalDC} ➔ <b>${success ? 'ERFOLG' : 'FEHLSCHLAG'}</b>]</span>`;

                const skillLabel = CONFIG.DND5E.skills[opt.check]?.label || opt.check.toUpperCase();
                await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: this.pc }), flavor: `Fertigkeitswurf: ${skillLabel} (SG ${finalDC})` });
            }

            // GM-Logbuch Text zusammenbauen
            const nextNode = this.fullTree[nextKey];
            let systemLog = "";
            if (nextNode) {
                if (nextNode.ship_mod) {
                    if (nextNode.ship_mod > 0) systemLog += `[Stimmung verbessert: +${nextNode.ship_mod}] `;
                    else if (nextNode.ship_mod < 0) systemLog += `[Stimmung verschlechtert: ${nextNode.ship_mod}] `;
                }
                if (nextNode.ship_tag) systemLog += `[Neues Ereignis: "${nextNode.ship_tag}"]`;
            }

            dispatchSystemEvent({ type: "choiceMade", npcId: this.npc.id, speaker, text: opt.text + resTxt, systemLog: systemLog, nextNodeText: nextNode?.text });
            if (nextKey) { this.currentNodeKey = nextKey; this.render(true); } 
            else { dispatchSystemEvent({ type: "closeObserver", npcId: this.npc.id }); this.close(); }
        });
    }
}