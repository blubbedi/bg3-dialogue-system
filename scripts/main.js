const MOD_ID = 'bg3-dialogue-system';

function dispatchSystemEvent(data) {
    if (game.user.isGM) {
        if (data.type === "choiceMade") BG3DialogueSystem.processChoice(data);
        else if (data.type === "closeObserver") BG3DialogueSystem.endConversation(data.npcId);
        else if (data.type === "updateRelationship") BG3DialogueSystem.updateRelationshipJournal(data.npcId, data.mod, data.tag);
        else if (data.type === "startCombat") BG3DialogueSystem.startCombat(data.npcId, data.pcId, data.speaker);
        else if (data.type === "processVote") BG3DialogueSystem.processVote(data);
        else if (data.type === "requestSkillCheck") BG3DialogueSystem.handleSkillRequest(data);
    } else {
        game.socket.emit(`module.${MOD_ID}`, data);
    }
}

Hooks.once('ready', async () => {
    game.socket.on(`module.${MOD_ID}`, async data => {
        const windows = Object.values(ui.windows).filter(a => a instanceof BG3DialogueWindow && a.npc.id === data.npcId);
        
        if (data.type === "showDialog") {
            if (game.user.id === data.receiverId || data.broadcast) {
                new BG3DialogueWindow(data.npcId, data.pcId, data.fullTree, data.startNode, false, data.relScore, data.relTags, data.isInitiator).render(true);
            }
        } else if (data.type === "syncVotes") {
            windows.forEach(w => { w.votes = data.votes; w.render(true); });
        } else if (data.type === "syncNode") {
            windows.forEach(w => { w.currentNodeKey = data.nextNode; w.votes = {}; w.render(true); });
        } else if (data.type === "spotlightRequest" && game.user.id === data.targetUserId) {
            const w = windows.find(win => !win.isObserver);
            if (w) { w.isSpotlight = true; w.spotlightData = data; w.render(true); }
        } else if (data.type === "closeAll") {
            windows.forEach(w => w.close());
        }
    });
});

class BG3DialogueSystem {
    static activeSessions = {};

    static async initiateDialogue(npcId, initiatorUserId) {
        const npc = game.actors.get(npcId);
        const rawJson = (npc.system.details.biography.value || "").replace(/<[^>]*>?/gm, '').trim();
        
        try {
            const fullTree = JSON.parse(rawJson);
            const relData = await this.getOrCreateRelationship(npc.name);
            const activeUsers = game.users.filter(u => u.active && u.character);
            
            this.activeSessions[npcId] = { initiatorId: initiatorUserId, votes: {}, fullTree, relScore: relData.score, relTags: relData.tags };

            activeUsers.forEach(u => {
                const isInitiator = u.id === initiatorUserId;
                game.socket.emit(`module.${MOD_ID}`, { 
                    type: "showDialog", npcId, pcId: u.character.id, receiverId: u.id, 
                    fullTree, startNode: "startNode", relScore: relData.score, relTags: relData.tags, isInitiator 
                });
            });
        } catch (e) { ui.notifications.error("JSON fehlerhaft."); }
    }

    static processVote(data) {
        const session = this.activeSessions[data.npcId];
        if (!session) return;
        session.votes[data.userId] = data.optionIndex;
        game.socket.emit(`module.${MOD_ID}`, { type: "syncVotes", npcId: data.npcId, votes: session.votes });
    }

    static handleSkillRequest(data) {
        const targetUser = game.users.find(u => u.character?.id === data.targetActorId);
        if (!targetUser) return;
        game.socket.emit(`module.${MOD_ID}`, { 
            type: "spotlightRequest", npcId: data.npcId, targetUserId: targetUser.id, 
            skill: data.skill, dc: data.dc, optIndex: data.optIndex 
        });
    }
}

class BG3DialogueWindow extends Application {
    constructor(npcId, pcId, fullTree, currentNodeKey, isObserver, relScore, relTags, isInitiator) {
        super();
        this.npc = game.actors.get(npcId);
        this.pc = pcId ? game.actors.get(pcId) : null;
        this.fullTree = fullTree;
        this.currentNodeKey = currentNodeKey;
        this.relScore = relScore;
        this.relTags = relTags;
        this.isInitiator = isInitiator;
        this.votes = {}; // userId: optionIndex
        this.isSpotlight = false;
        this.showDelegation = false;
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, { 
            id: "bg3-dialog-ui", template: "modules/bg3-dialogue-system/templates/dialog.html", width: 700, height: "auto"
        });
    }

    getData() {
        const node = this.fullTree[this.currentNodeKey];
        const options = (node.options || []).map((o, i) => {
            const votersForThis = Object.entries(this.votes)
                .filter(([uid, idx]) => idx === i)
                .map(([uid, idx]) => ({ name: game.users.get(uid).name, img: game.users.get(uid).character?.img }));
            return { ...o, voters: votersForThis, votedByMe: this.votes[game.user.id] === i };
        });

        return {
            npcName: this.npc.name, npcImg: this.npc.img, text: node.text,
            options, isInitiator: this.isInitiator, isSpotlight: this.isSpotlight,
            showDelegation: this.showDelegation,
            potentialDelegates: this.showDelegation ? this._getPotentialDelegates() : [],
            relationshipStatus: { class: this.relScore >= 5 ? "friendly" : (this.relScore <= -5 ? "hostile" : "neutral") }
        };
    }

    _getPotentialDelegates() {
        const node = this.fullTree[this.currentNodeKey];
        const opt = node.options[this.pendingOptIndex];
        return game.users.filter(u => u.active && u.character).map(u => ({
            id: u.character.id, name: u.character.name, img: u.character.img,
            bonus: u.character.system.skills[opt.check]?.total || 0
        }));
    }

    activateListeners(html) {
        html.find('.dialog-option').click(ev => {
            const idx = $(ev.currentTarget).data('index');
            const opt = this.fullTree[this.currentNodeKey].options[idx];

            if (!this.isInitiator) {
                dispatchSystemEvent({ type: "processVote", npcId: this.npc.id, userId: game.user.id, optionIndex: idx });
            } else {
                if (opt.check) {
                    this.showDelegation = true;
                    this.pendingOptIndex = idx;
                    this.render(true);
                } else {
                    this._executeChoice(idx);
                }
            }
        });

        html.find('.delegate-btn').click(ev => {
            const targetActorId = $(ev.currentTarget).data('actor-id');
            const opt = this.fullTree[this.currentNodeKey].options[this.pendingOptIndex];
            dispatchSystemEvent({ 
                type: "requestSkillCheck", npcId: this.npc.id, targetActorId, 
                skill: opt.check, dc: opt.dc, optIndex: this.pendingOptIndex 
            });
            this.showDelegation = false;
            this.render(true);
        });

        html.find('.spotlight-btn').click(async () => {
            // Hier würde der tatsächliche Roll-Code von Version 2.0.7 hinkommen
            // Nach dem Wurf wird das Ergebnis via Socket an den GM gesendet, der syncNode an alle schickt.
        });
    }
}