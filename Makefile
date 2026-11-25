UUID    = audio-device-ranker@guido.vera
EXT_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
FILES   = extension.js prefs.js metadata.json stylesheet.css

.PHONY: all install uninstall reinstall enable disable prefs schemas pack clean

all: install

## Compile the GSettings schema in the source tree (for local testing).
schemas:
	glib-compile-schemas schemas/

## Copy the extension into the user extensions directory and compile its schema.
install: schemas
	@mkdir -p "$(EXT_DIR)/schemas"
	@cp -f $(FILES) "$(EXT_DIR)/"
	@cp -f schemas/*.gschema.xml "$(EXT_DIR)/schemas/"
	@glib-compile-schemas "$(EXT_DIR)/schemas/"
	@echo "Installed to $(EXT_DIR)"
	@echo
	@echo "Next steps:"
	@echo "  * X11:     restart GNOME Shell with Alt+F2, type 'r', Enter"
	@echo "  * Wayland: log out and back in"
	@echo "  * Then run: make enable"

## Remove the installed extension.
uninstall:
	@rm -rf "$(EXT_DIR)"
	@echo "Removed $(EXT_DIR)"

## Reinstall from scratch.
reinstall: uninstall install

enable:
	gnome-extensions enable "$(UUID)"

disable:
	gnome-extensions disable "$(UUID)"

## Open the preferences window.
prefs:
	gnome-extensions prefs "$(UUID)"

## Build a distributable zip with gnome-extensions pack.
pack: schemas
	gnome-extensions pack --force \
		--extra-source=stylesheet.css

clean:
	rm -f schemas/gschemas.compiled
	rm -f $(UUID).shell-extension.zip
