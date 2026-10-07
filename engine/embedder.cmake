# The engine executable: WebCore embedded in-process, driven by the host page.
# Included by WebCore's port CMake file after the WebCore target is complete, so
# WebCore's private include directories and definitions apply here as well.

set(INCEPTION_ENGINE_DIR "${CMAKE_CURRENT_LIST_DIR}")

file(GLOB INCEPTION_ENGINE_SOURCES CONFIGURE_DEPENDS "${INCEPTION_ENGINE_DIR}/*/*.cpp")
file(GLOB INCEPTION_ENGINE_JS CONFIGURE_DEPENDS "${INCEPTION_ENGINE_DIR}/js/*.js")

add_executable(inception-engine ${INCEPTION_ENGINE_SOURCES})
set_target_properties(inception-engine PROPERTIES
    SUFFIX ".js"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)

target_include_directories(inception-engine PRIVATE
    ${INCEPTION_ENGINE_DIR}
    ${WebCore_PRIVATE_INCLUDE_DIRECTORIES}
    ${WebCore_DERIVED_SOURCES_DIR}
)
target_link_libraries(inception-engine PRIVATE WebKit::WebCore)

# Worker-side glue lives in js/; each file is a library the engine calls into.
foreach (js IN LISTS INCEPTION_ENGINE_JS)
    target_link_options(inception-engine PRIVATE "--js-library=${js}")
endforeach ()
set_property(TARGET inception-engine APPEND PROPERTY LINK_DEPENDS ${INCEPTION_ENGINE_JS})

target_link_options(inception-engine PRIVATE
    # WebKit runs on one pthread; the page's main thread stays free for the host.
    -pthread
    -sPROXY_TO_PTHREAD=1
    -sPTHREAD_POOL_SIZE=4
    -sDEFAULT_PTHREAD_STACK_SIZE=8MB
    -sSTACK_SIZE=8MB

    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=256MB
    -sMAXIMUM_MEMORY=4GB

    -sMIN_WEBGL_VERSION=2
    -sMAX_WEBGL_VERSION=2
    -sGL_ENABLE_GET_PROC_ADDRESS=1

    # Sockets are SOCKFS WebSockets tagged with this subprotocol; the host routes
    # them to its relay instead of opening real WebSockets.
    -sWEBSOCKET_SUBPROTOCOL=inception-tcp

    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createInceptionEngine
    -sENVIRONMENT=web,worker
    -sEXIT_RUNTIME=0
    -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8,HEAP32,FS,PThread
    -sEXPORTED_FUNCTIONS=_main,_malloc,_free

    "--preload-file=${INCEPTION_FS_DIR}@/"
)
