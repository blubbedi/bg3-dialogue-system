const MOD_ID = 'bg3-dialogue-system';

function log(msg) { console.log(`BG3-DIALOG | ${msg}`); }

// Weiche für Netzwerk vs. lokales GM-Event
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

    game.socket.on(`module.${MOD_ID}`, async data => {
        if (data.type === "showDialog" && game.user.id === data.receiverId) {
            new BG3DialogueWindow(data.npcId, data.pcId, data.fullTree, data.startNode, false, data.relScore, data.relTags).render(true);
        } 
        else if (data.type === "choiceMade" && game.user.isGM && game.users.activeGM?.isSelf) {
            await BG3DialogueSystem.processChoice(data);
        } 
        else if (data.type === "updateObserver" && game.user.isGM) {
            const openApp = Object.values(ui.windows).find(app => app instanceof BG3DialogueWindow && app.npc.id === data.npcId && app.isObserver);
            if (openApp) {
                openApp.currentNodeKey = data.nextNode;
                openApp.relScore = data.relScore;
                openApp.relTags = data.relTags;
                openApp.render(true);
            }
        } 
        else if (data.type === "closeObserver" && game.user.isGM && game.users.activeGM?.isSelf) {
            await BG3DialogueSystem.endConversation(data.npcId);
        }
        else if (data.type === "updateRelationship" && game.user.isGM && game.users.activeGM?.isSelf) {
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
        const folderName = game.settings.get(MOD_ID, 'npcFolder');
        let actorFolder = game.folders.find(f => f.name === folderName && f.type === "Actor");
        if (!actorFolder) actorFolder = await Folder.create({ name: folderName, type: "Actor", color: "#c1a35b" });

        let journalFolder = game.folders.find(f => f.name === "Gespräche" && f.type === "JournalEntry");
        if (!journalFolder) journalFolder = await Folder.create({ name: "Gespräche", type: "JournalEntry", color: "#c1a35b" });
        
        let relFolder = game.folders.find(f => f.name === "Beziehung" && f.folder?.id === journalFolder.id);
        if (!relFolder) await Folder.create({ name: "Beziehung", type: "JournalEntry", folder: journalFolder.id, color: "#8b0000" });

        let logsFolder = game.folders.find(f => f.name === "Logs" && f.folder?.id === journalFolder.id);
        if (!logsFolder) await Folder.create({ name: "Logs", type: "JournalEntry", folder: journalFolder.id, color: "#4db8ff" });
    }

    static async getOrCreateRelationship(npcName) {
        let parentFolder = game.folders.find(f => f.name === "Gespräche" && f.type === "JournalEntry");
        if (!parentFolder) parentFolder = await Folder.create({ name: "Gespräche", type: "JournalEntry", color: "#c1a35b" });

        let relFolder = game.folders.find(f => f.name === "Beziehung" && f.folder?.id === parentFolder.id);
        if (!relFolder) relFolder = await Folder.create({ name: "Beziehung", type: "JournalEntry", folder: parentFolder.id, color: "#8b0000" });

        let report = game.journal.find(j => j.name === npcName && j.folder?.id === relFolder.id);
        if (!report) {
            report = await JournalEntry.create({
                name: npcName, 
                folder: relFolder.id,
                pages: [{
                    name: "Status",
                    type: "text",
                    text: { content: `<h3>Status: ${npcName}</h3><p>Stimmung: 0 (Neutral)</p><ul></ul>` }
                }]
            });
            await report.setFlag(MOD_ID, "relationshipScore", 0);
            await report.setFlag(MOD_ID, "tags", []);
        }
        return {
            score: report.getFlag(MOD_ID, "relationshipScore") || 0,
            tags: report.getFlag(MOD_ID, "tags") || [],
            report: report
        };
    }

    static async updateRelationshipJournal(npcId, adjustment = 0, tag = null) {
        const npc = game.actors.get(npcId);
        if (!npc) return null;
        const relData = await this.getOrCreateRelationship(npc.name);
        if (!relData.report) return null;

        let newScore = relData.score + adjustment;
        let newTags = [...relData.tags];
        if (tag && !newTags.includes(tag)) newTags.push(tag);

        await relData.report.setFlag(MOD_ID, "relationshipScore", newScore);
        await relData.report.setFlag(MOD_ID, "tags", newTags);

        const status = newScore >= 5 ? "Freundlich" : (newScore <= -5 ? "Feindlich" : "Neutral");
        const newContent = `<h3>Status: ${npc.name}</h3><p>Stimmung: ${newScore} (${status})</p><h4>Ereignisse:</h4><ul>${newTags.map(t => `<li>${t}</li>`).join("")}</ul>`;

        let page = relData.report.pages.contents[0];
        if (page) {
            await page.update({ "text.content": newContent });
        } else {
            await JournalEntryPage.create({ name: "Status", type: "text", text: { content: newContent } }, { parent: relData.report });
        }
        
        return { score: newScore, tags: newTags };
    }

    static showSelectionDialog() {
        const folderName = game.settings.get(MOD_ID, 'npcFolder');
        const folder = game.folders.find(f => f.name === "Actor" && f.name === folderName);
        const allFolders = game.folders.filter(f => f.type === "Actor" && f.name === folderName);
        const npcs = game.actors.filter(a => allFolders.some(f => f.id === a.folder?.id));
        const players = game.users.filter(u => u.active && !u.isGM);

        if (npcs.length === 0) return ui.notifications.warn("Keine NPCs im BG3-Ordner.");

        let npcOptions = npcs.map(n => `<option value="${n.id}">${n.name}</option>`).join("");
        let playerOptions = `<option value="${game.user.id}">GM / Test-Modus</option>`;
        playerOptions += players.map(p => `<option value="${p.id}">${p.name} (${p.character?.name || "Kein Charakter"})</option>`).join("");

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
            const relData = await this.getOrCreateRelationship(npc.name);

            this.activeSessions[npcId] = {
                pcId: pcId, userId: userId, history: [`<b>${npc.name}:</b> ${startText}`]
            };

            ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: npc }),
                content: `<div class="bg3-chat-msg npc-msg"><b>${npc.name}:</b> ${startText}</div>`
            });

            if (userId === game.user.id) {
                new BG3DialogueWindow(npcId, pcId, fullTree, "startNode", false, relData.score, relData.tags).render(true);
            } else {
                game.socket.emit(`module.${MOD_ID}`, {
                    type: "showDialog", npcId: npcId, pcId: pcId, receiverId: userId,
                    fullTree: fullTree, startNode: "startNode", relScore: relData.score, relTags: relData.tags
                });
                new BG3DialogueWindow(npcId, pcId, fullTree, "startNode", true, relData.score, relData.tags).render(true);
            }
            
        } catch (e) {
            log(e);
            ui.notifications.error("Die Biografie enthält kein valides JSON.");
        }
    }

    static async processChoice(data) {
        const npc = game.actors.get(data.npcId);
        const pc = data.pcId ? game.actors.get(data.pcId) : null;
        const speakerName = pc ? pc.name : (game.users.get(data.playerId)?.name || "Unbekannt");
        
        let systemLog = ""; 

        if (data.ship_mod || data.ship_tag) {
            const relUpdate = await this.updateRelationshipJournal(data.npcId, data.ship_mod || 0, data.ship_tag);
            if (relUpdate) {
                if (data.ship_mod > 0) systemLog += `[Stimmung verbessert: +${data.ship_mod} ➔ Neu: ${relUpdate.score}] `;
                else if (data.ship_mod < 0) systemLog += `[Stimmung verschlechtert: ${data.ship_mod} ➔ Neu: ${relUpdate.score}] `;
                if (data.ship_tag) systemLog += `[Neues Ereignis gemerkt: "${data.ship_tag}"]`;
            }
        }

        if (this.activeSessions[data.npcId]) {
            this.activeSessions[data.npcId].history.push(`<b>${speakerName}:</b> ${data.text}`);
            if (systemLog !== "") {
                this.activeSessions[data.npcId].history.push(`<span style="color: #8b0000; font-size: 0.9em;"><i>${systemLog}</i></span>`);
            }
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
            const logTitle = `${npc.name} & ${pc ? pc.name : "Unbekannt"}`;
            const timestamp = new Date().toLocaleString("de-DE", { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            
            let parentFolder = game.folders.find(f => f.name === "Gespräche" && f.type === "JournalEntry");
            if (!parentFolder) parentFolder = await Folder.create({ name: "Gespräche", type: "JournalEntry", color: "#c1a35b" });

            let logsFolder = game.folders.find(f => f.name === "Logs" && f.folder?.id === parentFolder.id);
            if (!logsFolder) logsFolder = await Folder.create({ name: "Logs", type: "JournalEntry", folder: parentFolder.id, color: "#4db8ff" });

            // Suche nach existierendem Logbuch
            let logEntry = game.journal.find(j => j.name === logTitle && j.folder?.id === logsFolder.id);
            const newHistory = `<hr><h3>Gespräch vom ${timestamp}</h3>` + session.history.map(line => `<p style="margin-bottom: 5px;">${line}</p>`).join("");

            if (logEntry) {
                let page = logEntry.pages.contents[0];
                const oldContent = page ? page.text.content : "";
                if (page) {
                    await page.update({ "text.content": oldContent + newHistory });
                } else {
                    await JournalEntryPage.create({ name: "Protokoll", type: "text", text: { content: newHistory } }, { parent: logEntry });
                }
            } else {
                let permissions = { default: 0 }; 
                if (session.userId) permissions[session.userId] = 2;

                await JournalEntry.create({
                    name: logTitle,
                    folder: logsFolder.id,
                    ownership: permissions,
                    pages: [{
                        name: "Protokoll",
                        type: "text",
                        text: { content: newHistory }
                    }]
                });
            }
            delete this.activeSessions[npcId];
        }

        const openApp = Object.values(ui.windows).find(app => app instanceof BG3DialogueWindow && app.npc.id === npcId && app.isObserver);
        if (openApp) openApp.close();
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
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "bg3-dialog-ui",
            template: `modules/${MOD_ID}/templates/dialog.html`,
            width: 700, height: "auto", popOut: true, title: "Gespräch"
        });
    }

    async _render(force=false, options={}) {
        await this._handleReactiveInsight();
        return super._render(force, options);
    }

    async _handleReactiveInsight() {
        if (this.isObserver) return;
        const node = this.fullTree[this.currentNodeKey];
        if (node && node.reactive_check && this.insightResults[this.currentNodeKey] === undefined) {
            const finalDC = node.reactive_check.dc + this._getDCMod();
            const skillBonus = this.pc ? (this.pc.system.skills[node.reactive_check.skill]?.total || 0) : 0;
            
            let roll = await new Roll("1d20").evaluate();
            let d20 = roll.total;
            if (d20 === 1 && this._isHalfling()) {
                roll = await new Roll("1d20").evaluate();
                d20 = roll.total;
            }

            const success = (d20 + skillBonus) >= finalDC;
            this.insightResults[this.currentNodeKey] = success;

            if (success && node.reactive_check.ship_tag) {
                this.relTags.push(node.reactive_check.ship_tag);
                dispatchSystemEvent({ type: "updateRelationship", npcId: this.npc.id, mod: 0, tag: node.reactive_check.ship_tag });
            }
        }
    }

    _getDCMod() {
        if (this.relScore <= -5) return 5;
        if (this.relScore < 0) return 2;
        if (this.relScore >= 5) return -5;
        if (this.relScore > 0) return -2;
        return 0;
    }

    _isHalfling() {
        if (!this.pc) return false;
        const raceItem = this.pc.items.find(i => i.type === "race");
        const raceStr = raceItem ? raceItem.name.toLowerCase() : (this.pc.system.details.race?.toLowerCase() || "");
        return raceStr.includes("halbling") || raceStr.includes("halfling");
    }

    getData() {
        const node = this.fullTree[this.currentNodeKey];
        let filteredOptions = (node?.options || []).filter(opt => !opt.condition_tag || this.relTags.includes(opt.condition_tag));

        const options = filteredOptions.map(opt => {
            let displayHtml = opt.text;
            if (opt.check && this.pc) {
                const mod = this.pc.system.skills[opt.check]?.total || 0;
                displayHtml = opt.text.replace(/\[(.*?)\]/, `[$1 ${mod >= 0 ? '+' : ''}${mod}]`);
            }
            return { ...opt, displayHtml };
        });
        
        const statusObj = this.relScore >= 5 ? {class: "friendly", name: "Freundlich"} : 
                         (this.relScore <= -5 ? {class: "hostile", name: "Feindlich"} : {class: "neutral", name: "Neutral"});

        return {
            npcName: this.npc.name, npcImg: this.npc.img,
            pcName: this.pc ? this.pc.name : null, pcImg: this.pc ? this.pc.img : null,
            text: node ? node.text : "...",
            options: options,
            isEndNode: options.length === 0,
            isObserver: this.isObserver,
            relationshipStatus: statusObj,
            showInsight: this.insightResults[this.currentNodeKey] === true,
            insightText: node?.reactive_check?.success_text,
            hasInspiration: this.pc ? this.pc.system.attributes.inspiration : false
        };
    }

    activateListeners(html) {
        super.activateListeners(html);
        
        html.find('.dialog-option').click(async ev => {
            if (this.isObserver) return;
            const idx = $(ev.currentTarget).data('index');
            const node = this.fullTree[this.currentNodeKey];
            const availableOptions = node.options.filter(opt => !opt.condition_tag || this.relTags.includes(opt.condition_tag));
            const selected = availableOptions[idx];
            
            let nextNodeKey = selected.nextNode;
            let chatText = selected.text;
            let rollResultText = "";

            if (selected.check && this.pc) {
                const mod = this.pc.system.skills[selected.check]?.total || 0;
                chatText = selected.text.replace(/\[(.*?)\]/, `[$1 ${mod >= 0 ? '+' : ''}${mod}]`);
                const finalDC = selected.dc + this._getDCMod();
                
                let roll = await new Roll("1d20").evaluate();
                let d20 = roll.total;
                
                if (d20 === 1 && this._isHalfling()) {
                    ui.notifications.info("🍀 Halblingsglück!");
                    roll = await new Roll("1d20").evaluate();
                    d20 = roll.total;
                }

                let total = d20 + mod;
                const useInspiration = html.find('#use-inspiration').is(':checked');
                
                if (total < finalDC && useInspiration && this.pc.system.attributes.inspiration) {
                    ui.notifications.warn("✨ Inspiration genutzt!");
                    await this.pc.update({"system.attributes.inspiration": false});
                    roll = await new Roll("1d20").evaluate();
                    d20 = roll.total;
                    total = d20 + mod;
                }

                if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true);

                const isSuccess = total >= finalDC;
                nextNodeKey = isSuccess ? selected.passNode : selected.failNode;
                const resultColor = isSuccess ? "#4db8ff" : "#ff4d4d";
                rollResultText = `<br><span style="color: ${resultColor}; font-size: 0.85em;">↳ [Wurf: ${roll.total} vs SG ${finalDC} (Basis ${selected.dc}) ➔ <b>${isSuccess ? "ERFOLG" : "FEHLSCHLAG"}</b>]</span>`;

                const skillLabel = CONFIG.DND5E.skills[selected.check]?.label || selected.check.toUpperCase();
                await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: this.pc }), flavor: `Fertigkeitswurf: ${skillLabel} (SG ${finalDC})` });
            }

            if (selected.ship_mod) {
                this.relScore += selected.ship_mod;
                if (selected.ship_mod > 0) ui.notifications.info(`Die Stimmung von ${this.npc.name} bessert sich.`);
                else if (selected.ship_mod < 0) ui.notifications.warn(`Die Stimmung von ${this.npc.name} verschlechtert sich!`);
            }
            if (selected.ship_tag) this.relTags.push(selected.ship_tag);

            dispatchSystemEvent({
                type: "choiceMade", npcId: this.npc.id, pcId: this.pc ? this.pc.id : null, playerId: game.user.id,
                text: chatText + rollResultText,
                nextNodeText: (nextNodeKey && this.fullTree[nextNodeKey]) ? this.fullTree[nextNodeKey].text : null,
                ship_mod: selected.ship_mod, ship_tag: selected.ship_tag
            });

            if (nextNodeKey && this.fullTree[nextNodeKey]) {
                this.currentNodeKey = nextNodeKey;
                this.render(true);
                if (!game.user.isGM) game.socket.emit(`module.${MOD_ID}`, { type: "updateObserver", npcId: this.npc.id, nextNode: nextNodeKey, relScore: this.relScore, relTags: this.relTags });
            } else {
                dispatchSystemEvent({ type: "closeObserver", npcId: this.npc.id });
                this.close();
            }
        });

        html.find('.dialog-close-btn').click(ev => {
            if (this.isObserver) return;
            dispatchSystemEvent({ type: "choiceMade", npcId: this.npc.id, pcId: this.pc?.id, playerId: game.user.id, text: "<i>*Verlässt das Gespräch*</i>", nextNodeText: null });
            dispatchSystemEvent({ type: "closeObserver", npcId: this.npc.id });
            this.close();
        });
    }
}