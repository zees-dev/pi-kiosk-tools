/* uinput-mouse: creates a virtual mouse and reads events from stdin.
 * Protocol: 24-byte input_event structs (same as /dev/input/eventN)
 * Write 1-3 events at a time, ending with SYN_REPORT.
 */
#include <linux/uinput.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <signal.h>

static int ufd = -1;

void cleanup(int sig) {
    if (ufd >= 0) {
        ioctl(ufd, UI_DEV_DESTROY);
        close(ufd);
    }
    _exit(0);
}

int main() {
    signal(SIGINT, cleanup);
    signal(SIGTERM, cleanup);
    signal(SIGPIPE, SIG_IGN);

    ufd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
    if (ufd < 0) { perror("open /dev/uinput"); return 1; }

    ioctl(ufd, UI_SET_EVBIT, EV_REL);
    ioctl(ufd, UI_SET_RELBIT, REL_X);
    ioctl(ufd, UI_SET_RELBIT, REL_Y);
    ioctl(ufd, UI_SET_RELBIT, REL_WHEEL);
    ioctl(ufd, UI_SET_EVBIT, EV_KEY);
    ioctl(ufd, UI_SET_KEYBIT, BTN_LEFT);
    ioctl(ufd, UI_SET_KEYBIT, BTN_RIGHT);
    ioctl(ufd, UI_SET_KEYBIT, BTN_MIDDLE);
    
    /* Enable all keyboard keys (KEY_ESC through KEY_MAX) */
    for (int k = 1; k < KEY_MAX; k++) {
        ioctl(ufd, UI_SET_KEYBIT, k);
    }

    struct uinput_setup setup = {0};
    setup.id.bustype = BUS_VIRTUAL;
    setup.id.vendor = 0x1234;
    setup.id.product = 0xABCD;
    setup.id.version = 1;
    strcpy(setup.name, "Kiosk Virtual Mouse");

    if (ioctl(ufd, UI_DEV_SETUP, &setup) < 0) { perror("UI_DEV_SETUP"); return 1; }
    if (ioctl(ufd, UI_DEV_CREATE) < 0) { perror("UI_DEV_CREATE"); return 1; }

    fprintf(stderr, "uinput-mouse: device created\n");
    fflush(stderr);

    /* Read input_event structs from stdin and forward to uinput */
    struct input_event ev;
    while (1) {
        ssize_t n = read(0, &ev, sizeof(ev));
        if (n <= 0) break;
        if (n == sizeof(ev)) {
            write(ufd, &ev, sizeof(ev));
        }
    }

    cleanup(0);
    return 0;
}
