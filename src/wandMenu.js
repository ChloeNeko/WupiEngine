/**
 * Wand menu (the magic wand dropdown next to the send bar, #extensionsMenu)
 * plumbing for WUPI Engine. Follows the same item markup as the other
 * extensions that live in this menu.
 */

/**
 * Adds one clickable entry to the wand extensions menu.
 *
 * @param {object} opts
 *   - id: stable DOM id, also used as the duplicate guard
 *   - icon: Font Awesome class after 'fa-solid' (e.g. 'fa-shield-halved')
 *   - label: visible text
 *   - title: tooltip text
 *   - onClick(): called when the entry is clicked
 * @returns {boolean} true when the item is (or already was) in the menu
 */
export function addWandMenuItem({ id, icon, label, title, onClick }) {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    if (document.getElementById(id)) return true;

    const item = document.createElement('div');
    item.id = id;
    item.className = 'list-group-item flex-container flexGap5 interactable wupi-engine-item';
    item.title = title;
    item.tabIndex = 0;

    const i = document.createElement('i');
    i.className = `fa-solid ${icon}`;
    const span = document.createElement('span');
    span.textContent = label;
    item.append(i, span);

    item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
    });

    menu.append(item);
    return true;
}
